"""WebSocket command the panel uses to obtain / renew a browsing session."""
from __future__ import annotations

import time

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant

from .const import (
    CONF_HOME_URL,
    CONF_REQUIRE_ADMIN,
    CONF_SEARCH_URL,
    DOMAIN,
    PROXY_BASE,
)


@websocket_api.websocket_command(
    {vol.Required("type"): "ha_browser/session", vol.Optional("token"): vol.Any(str, None)}
)
@websocket_api.async_response
async def ws_session(hass: HomeAssistant, connection, msg) -> None:
    runtime = hass.data.get(DOMAIN, {}).get("runtime")
    if runtime is None:
        connection.send_error(msg["id"], "not_loaded", "HA Browser is not loaded")
        return
    if runtime.options[CONF_REQUIRE_ADMIN] and not connection.user.is_admin:
        connection.send_error(msg["id"], "unauthorized", "Admin access required")
        return

    mgr = runtime.manager
    sess = None
    if token := msg.get("token"):
        existing = mgr.get(token)
        if existing and existing.user_id == connection.user.id:
            sess = existing
    if sess is None:
        sess = mgr.create(connection.user.id)

    connection.send_result(
        msg["id"],
        {
            "token": sess.token,
            "prefix": f"{PROXY_BASE}/{sess.token}",
            "home_url": runtime.options[CONF_HOME_URL],
            "search_url": runtime.options[CONF_SEARCH_URL],
            "ttl": mgr.ttl,
        },
    )


@websocket_api.websocket_command({vol.Required("type"): "ha_browser/debug", vol.Required("token"): str})
@websocket_api.async_response
async def ws_debug(hass: HomeAssistant, connection, msg) -> None:
    """Recent proxied requests for this user's session (for the diagnostics drawer)."""
    runtime = hass.data.get(DOMAIN, {}).get("runtime")
    sess = runtime.manager.get(msg["token"]) if runtime else None
    if sess is None or sess.user_id != connection.user.id:
        connection.send_error(msg["id"], "not_found", "Unknown session")
        return
    now = time.monotonic()
    items = [
        {
            "m": e["m"], "u": e["u"], "s": e["s"], "ct": e["ct"], "e": e["e"],
            "ms": e["ms"], "age": int((now - e["t"]) * 1000),
        }
        for e in list(sess.trace)
    ]
    connection.send_result(msg["id"], {"items": items})
