from dataclasses import replace
from urllib.parse import urlsplit

import pytest
from fastapi.testclient import TestClient

from smarthome import log_search
from smarthome.config import Settings
from smarthome.main import create_app

KEY = 'existing-owner-service-key'
OWNER = {'X-API-Key': KEY}
BASE = '/api/v1/log-search'


@pytest.fixture
def logs(tmp_path):
    config = Settings(database_path=str(tmp_path/'logs.db'), api_token=KEY,
                      log_search_url='https://homeassistant.dom:8096', display_poll_interval=0)
    with TestClient(create_app(config), base_url='https://homeassistant.dom:8096') as client:
        yield client


def test_owner_handoff_has_no_app_key_and_cookie_is_scoped(logs):
    response = logs.post(BASE+'/ticket', headers=OWNER)
    assert response.status_code == 200
    assert response.headers['cache-control'] == 'no-store'
    result = response.json()
    assert KEY not in response.text
    assert urlsplit(result['url']).query == ''
    assert logs.get(BASE+'/authorize').status_code == 401
    signed_in = logs.post(BASE+'/session', data={'ticket': result['ticket']}, follow_redirects=False)
    assert signed_in.status_code == 303
    assert signed_in.headers['location'] == 'https://homeassistant.dom:8096/select/vmui/'
    cookie = signed_in.headers['set-cookie']
    for flag in ('HttpOnly', 'Secure', 'SameSite=lax', 'Path=/select/', 'Max-Age=1800'):
        assert flag in cookie
    assert KEY not in cookie and result['ticket'] not in cookie
    value = signed_in.cookies.get(log_search.COOKIE)
    assert logs.get(BASE+'/authorize', headers={'Cookie':f'{log_search.COOKIE}={value}'}).status_code == 204
    # The scoped cookie is not an app credential.
    assert logs.get('/api/v1/accounts/me', headers={'Cookie':f'{log_search.COOKIE}={value}'}).status_code == 401


def test_member_and_anonymous_cannot_get_ticket(logs):
    assert logs.post(BASE+'/ticket').status_code == 401
    member = logs.post('/api/v1/accounts', headers=OWNER, json={'name':'Member'}).json()
    assert logs.post(BASE+'/ticket', headers={'X-API-Key':member['access_key']}).status_code == 403
    assert 'log_search_supported' not in logs.get('/api/v1/cloud/status', headers={'X-API-Key':member['access_key']}).json()
    assert logs.get('/api/v1/cloud/status', headers=OWNER).json()['log_search_supported'] is True


def test_expiry_tampering_purpose_and_gateway_binding(logs, monkeypatch):
    now = 1000000
    monkeypatch.setattr(log_search.time, 'time', lambda: now)
    ticket = logs.post(BASE+'/ticket', headers=OWNER).json()['ticket']
    assert logs.get(BASE+'/authorize', headers={'Cookie':f'{log_search.COOKIE}={ticket}'}).status_code == 401
    assert logs.post(BASE+'/session', data={'ticket':ticket+'x'}).status_code == 401
    config = logs.app.state.settings
    assert not log_search.valid(replace(config, log_search_url='https://other.test'), 'ticket', ticket, 60)
    assert not log_search.valid(replace(config, api_token='different'), 'ticket', ticket, 60)
    session = log_search.issue(config, 'session', log_search.SESSION_TTL)
    now += 61
    assert logs.post(BASE+'/session', data={'ticket':ticket}).status_code == 401
    now += 1800
    assert logs.get(BASE+'/authorize', headers={'Cookie':f'{log_search.COOKIE}={session}'}).status_code == 401


def test_invalid_or_oversized_handoff_and_disabled_feature(logs):
    assert logs.post(BASE+'/session', json={'ticket':'no'}).status_code == 415
    assert logs.post(BASE+'/session', data={'ticket':'x'*1100}).status_code == 413
    assert logs.post(BASE+'/session', data={'ticket':['one','two']}).status_code == 401
    assert logs.post(BASE+'/session', data={'ticket':'a','other':'b','extra':'c'}).status_code == 401
    logs.app.state.settings = replace(logs.app.state.settings, log_search_url='')
    assert logs.post(BASE+'/ticket', headers=OWNER).status_code == 404
    assert logs.get(BASE+'/authorize').status_code == 404


def test_search_requires_secure_origin():
    for url in ('http://logs.test', 'https://logs.test/path', 'https://user:key@logs.test'):
        with pytest.raises(ValueError): Settings(log_search_url=url)
