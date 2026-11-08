# Tuya scenes and automation boundaries

Research snapshot: 7 October 2026. Tuya has scene-editing APIs, but access depends on the selected SDK, permissions, and project plan. A User Code/QR session does not automatically grant a scene editor to this service.

| Connection | Read scenes | Trigger | Create/edit/delete |
| --- | --- | --- | --- |
| TinyTuya/LAN here | No universal cloud catalog | No universal cloud scene call | No cloud scene CRUD |
| Sharing SDK 0.2.15 | SDK `query_scenes`; service GET `/api/v1/cloud/scenes` | SDK `trigger_scene`; not exposed by our service | Not provided by this SDK |
| Cloud OpenAPI with suitable permissions | Defined by Tuya | Defined by Tuya | Requires appropriate permissions/services |
| Smart App SDK | Supported by its own integration | Supported | Separate mobile SDK integration |

The installed Sharing `SceneRepository` exposes query/trigger rather than editing. Its internal routes include `/v1.0/m/scene/ha/home/scenes` and `/v1.0/m/scene/ha/trigger`. See the [official SDK](https://github.com/tuya/tuya-device-sharing-sdk). Our endpoint provides a safe catalog; there is no service trigger/editor endpoint. Developer scenes return 501.

## Separate concepts

A bulb's `scene_data` or `scene_data_v2` is a device lighting effect, not a home automation such as motion turning on three lamps. Editing the bulb's effect does not modify an existing Smart Life automation.

Local [groups](displays.md) can switch several devices, but this is not a server automation engine.

A rule such as fresh motion → group on → timed off would require a separately implemented rule engine and a reliable event source. Periodic polling can miss short motion events; it must not be presented as complete motion history.

## Further integration

Tuya's [Modify Scene documentation](https://developer.tuya.com/en/docs/archived-documents/774321d68c?id=Kc29dc54ceuz0) describes a different cloud interface. Implementing it requires checking current project permissions, supported conditions/actions, validation, and plan terms. This project does not buy subscriptions or bypass closed app APIs. A working device-control login alone does not establish permission to modify cloud automations.
