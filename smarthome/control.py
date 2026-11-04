from .models import Device, utcnow
from .schemas import CommandRead
from .service import commit, get_or_404, record_observations


def run_command(request, session, item, command, dps=None):
    from .activity import record_command
    parent = get_or_404(session, Device, item.parent_id) if item.parent_id else None
    # Release the read transaction while doing blocking LAN I/O. expire_on_commit=False
    # retains the configuration snapshot used for this command.
    if dps is not None:
        record_command(session, "local", item.device_id, dps, "sent", item.local_key)
    session.commit()
    try:
        observed = request.app.state.controller.execute(item, parent, dps=dps)
    except Exception as error:
        if dps is not None:
            from fastapi import HTTPException
            rejected = isinstance(error, HTTPException) and error.status_code in {400, 403, 404, 409, 422}
            record_command(session, "local", item.device_id, dps, "rejected" if rejected else "unknown", item.local_key)
            session.commit()
        raise
    if dps is not None:
        record_command(session, "local", item.device_id, dps, "accepted", item.local_key)
    observed_at = utcnow()
    record_observations(session, item, observed, observed_at)
    commit(session)
    # Empty control acknowledgement does not prove the requested physical state.
    return CommandRead(
        device_id=item.id, command=command, acknowledged=True, dps=observed, observed_at=observed_at
    )
