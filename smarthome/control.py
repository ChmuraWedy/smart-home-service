from .models import Device, utcnow
from .schemas import CommandRead
from .service import commit, get_or_404, record_observations


def run_command(request, session, item, command, dps=None):
    parent = get_or_404(session, Device, item.parent_id) if item.parent_id else None
    # Release the read transaction while doing blocking LAN I/O. expire_on_commit=False
    # retains the configuration snapshot used for this command.
    session.commit()
    observed = request.app.state.controller.execute(item, parent, dps=dps)
    observed_at = utcnow()
    record_observations(session, item, observed, observed_at)
    commit(session)
    # Empty control acknowledgement does not prove the requested physical state.
    return CommandRead(
        device_id=item.id, command=command, acknowledged=True, dps=observed, observed_at=observed_at
    )
