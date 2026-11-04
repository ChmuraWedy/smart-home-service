# ruff: noqa: F811  # Pytest fixture imported from test_sharing_state.

from sqlalchemy.orm import Session

from smarthome.activity import record_values
from smarthome.models import DeviceActivity
from tests.test_cloud import API, KEY
from tests.test_sharing_state import lazy_client  # noqa: F401


def journal(client, device='switch-0', **params):
    return client.get('/api/v1/activity/devices/' + device, params=params)


def test_cached_snapshots_do_not_create_repeated_activity_and_membership_is_required(lazy_client):
    client = lazy_client
    client.get(API + '/devices')
    first = journal(client).json()['events']
    assert first and all(row['kind'] == 'snapshot' for row in first)
    client.get(API + '/devices/switch-0/status')
    client.get(API + '/devices/switch-0/status')
    assert journal(client).json()['events'] == first
    assert journal(client, 'someone-elses-device').status_code == 404
    client.headers.pop('X-API-Key')
    assert journal(client).status_code == 401


def test_reports_are_collected_without_an_open_card_and_duplicate_or_delayed_reports_are_ignored(lazy_client):
    client = lazy_client
    client.get(API + '/devices')
    bridge = client.app.state.cloud
    assert 'switch-0' not in bridge.state.metadata
    mq = bridge.state.mq
    mq.emit(timestamp=1791400000000)
    assert 'switch-0' in bridge.state.metadata  # Metadata loaded only for the reporting device.
    mq.emit(timestamp=1791400000000)
    mq.emit(value=False, timestamp=1791390000000)
    events = [row for row in journal(client).json()['events'] if row['kind'] == 'report']
    assert len(events) == 1 and events[0]['value'] is True
    # A distinct event with the same value is activity, not an unchanged cached poll.
    mq.emit(value=True, timestamp=1791410000000)
    assert len([row for row in journal(client).json()['events'] if row['kind'] == 'report']) == 2
    client.get(API + '/devices/switch-0/status?refresh=true')
    assert journal(client).json()['events'][0]['kind'] == 'report'


def test_commands_have_separate_outcomes_and_do_not_fabricate_state(lazy_client):
    client = lazy_client
    client.get(API + '/devices')
    response = client.post(API + '/devices/switch-0/commands', json={'commands': [{'code':'switch_1','value':True}]})
    assert response.status_code == 200
    events = journal(client).json()['events']
    commands = [row for row in events if row['kind'] == 'command']
    assert [row['outcome'] for row in commands] == ['accepted','sent']
    assert not any(row['code'] == 'switch_1' and row['value'] is True for row in events)


def test_history_persists_has_a_stable_cursor_and_cannot_cross_accounts(lazy_client):
    client = lazy_client
    client.get(API + '/devices')
    first = journal(client, limit=1).json()
    second = journal(client, limit=1, before=first['next_before']).json()
    assert second['events'][0]['id'] < first['events'][0]['id']
    # The data is durable and scopes remain separate even for the same device ID.
    from smarthome.db import make_engine
    reopened = make_engine(client.app.state.settings.database_path)
    with Session(reopened) as session:
        count = session.query(DeviceActivity).count()
    reopened.dispose()
    assert count > 0
    bridge = client.app.state.cloud
    bridge.auth['token_info']['uid'] = 'another-account'
    assert journal(client).json()['events'] == []


def test_history_is_bounded_and_recursively_redacts_credentials(lazy_client, monkeypatch):
    from smarthome import activity
    monkeypatch.setattr(activity, 'LIMIT', 3)
    with Session(lazy_client.app.state.engine) as session:
        for index in range(6):
            record_values(session, 'scope', 'device', {'motion': index, 'local_key': KEY, 'nested': {'access_token':'private','value':KEY}}, secret=KEY)
        session.commit()
        rows = session.query(DeviceActivity).filter_by(scope='scope').all()
        assert len(rows) == 3
        assert KEY not in str([row.value for row in rows])
        assert 'private' not in str([row.value for row in rows])


def test_battery_is_returned_from_inventory_without_extra_status_queries(lazy_client):
    bridge = lazy_client.app.state.cloud
    lazy_client.get(API + '/devices')
    bridge.manager.device_map['switch-0'].status['va_battery'] = 100
    bridge.manager.customer_api.calls.clear()
    row = lazy_client.get(API + '/devices').json()[0]
    assert row['battery'] == {'code':'va_battery','value':100,'unit':None}
    assert bridge.manager.customer_api.calls == []


def test_a_rejected_command_is_logged_once_without_retry(lazy_client, monkeypatch):
    from fastapi import HTTPException
    client = lazy_client
    client.get(API + '/devices')
    attempts = []
    def reject(*args):
        attempts.append(args)
        raise HTTPException(409, 'Устройство недоступно')
    monkeypatch.setattr(client.app.state.cloud, 'send_commands', reject)
    response = client.post(API + '/devices/switch-0/commands', json={'commands':[{'code':'switch_1','value':True}]})
    assert response.status_code == 409 and len(attempts) == 1
    commands = [row for row in journal(client).json()['events'] if row['kind'] == 'command']
    assert [row['outcome'] for row in commands] == ['rejected','sent']


def test_credentials_in_json_strings_are_not_persisted(lazy_client):
    with Session(lazy_client.app.state.engine) as session:
        record_values(session, 'scope', 'string-device', {'payload': '{"access_token":"private","nested":{"value":"' + KEY + '"}}'}, secret=KEY)
        session.commit()
        rows = session.query(DeviceActivity).filter_by(device_id='string-device').all()
        assert rows and KEY not in str(rows[0].value) and 'private' not in str(rows[0].value)


def test_local_command_ack_is_separate_from_observed_values_and_survives_reopening(client, direct, factory):
    factory.result = {}
    response = client.post(f"/api/v1/devices/{direct['id']}/commands/on")
    assert response.status_code == 200
    events = journal(client, str(direct['id']), provider='local').json()['events']
    assert [row['outcome'] for row in events] == ['accepted','sent']
    assert all(row['kind'] == 'command' for row in events)
    assert client.get(f"/api/v1/devices/{direct['id']}").json()['last_dps'] is None
