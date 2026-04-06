# Vent automation — per-room target temperature (frontend API guide)

This document is for **frontend / app** authors integrating the **temporary per-room comfort target** feature. It complements [Vent-Dashboard.md](./Vent-Dashboard.md) (architecture and full dashboard API).

**Auth:** Same as other device routes: `Authorization: Bearer <JWT>` with **normal user** permission (see [API.md](./API.md)). Use `Content-Type: application/json` for POST bodies.

---

## Summary

| Change | Details |
|--------|---------|
| **New endpoint** | `POST /vents/room-target` — set or cancel a per-room target (vent-mapped rooms only). |
| **Updated response** | `GET /vents/actions` — each **`rooms[]`** row that includes vent fields may include **`roomTargetOverrideC`** and **`roomTargetOverrideUntilMs`**. |
| **Unchanged** | `GET /vents`, `POST /vents/:motorId/:percent`, and the rest of `GET /vents/actions` are unchanged except for the extra room fields above. |

Behavior (server-side, good for UI tooltips):

- Overrides apply **only** to rooms that are keys in **`ventAutomation.roomVentMap`** (same strings Zigbee / dashboard use).
- A **set** lasts **20 hours** from the successful request (`untilMs` in the response).
- Overrides are stored **in memory**; a **process restart** clears them.
- The server **clears every room override** when automation observes a direct transition **cooling ↔ heating** (based on the **controller room** temperature and global `coolTargetC` / `heatTargetC`). Transitions **to or from `idle`** do **not** clear overrides.
- While an override is active for a room, **vent open/close decisions** for that room use the override as both band edges (see semantics below); **global** `targets` in the dashboard still show the config defaults.

---

## `POST /vents/room-target`

**Purpose:** Set a temporary target °C for **one** vent-mapped room, or cancel the override for that room.

### Set a target

**Body (JSON):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `room` | string | Yes | Exact key from `ventAutomation.roomVentMap` (e.g. `"Peter's Room"`). Trimmed server-side; must not be empty. |
| `targetC` | number | Yes | Desired comfort temperature in **°C**. Must be finite and between **5** and **35** (inclusive). |

**Success `200` JSON:**

| Field | Type | Description |
|-------|------|-------------|
| `success` | `true` | |
| `error` | `""` | |
| `room` | string | Same as request (trimmed). |
| `targetC` | number | Echo of accepted value. |
| `untilMs` | number | Epoch ms when the override expires (set time + 20 hours). |

**Error responses:**

| Status | `error` | When |
|--------|---------|------|
| `400` | `invalid_body` | Missing/empty `room`, non-numeric `targetC`, or wrong types. |
| `400` | `targetC_out_of_range` | `targetC` outside [5, 35]. |
| `400` | `invalid_room` | Internal validation (should not occur if `room` is a non-empty string). |
| `404` | `unknown_room` | `room` is not a key in `roomVentMap`. |

After success, the server runs **one automation tick** from the current Zigbee snapshot (same as cancel).

### Cancel an override

Use the **same path** with a cancel flag (no separate DELETE route).

**Body (JSON):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `room` | string | Yes | Same as for set. |
| `cancel` | boolean | Yes | Must be JSON boolean **`true`** (string `"true"` is **not** accepted). |

**Success `200` JSON:**

| Field | Type | Description |
|-------|------|-------------|
| `success` | `true` | |
| `error` | `""` | |
| `room` | string | Trimmed room name. |
| `cancel` | `true` | Confirms cancel path. |
| `hadActiveOverride` | boolean | `true` if an **unexpired** override was removed; `false` if there was nothing active (idempotent). |

**Error responses:**

| Status | `error` | When |
|--------|---------|------|
| `400` | `invalid_body` | Empty `room` or `cancel` not boolean `true`. |
| `404` | `unknown_room` | `room` not in `roomVentMap`. |

### Examples

```http
POST /vents/room-target
Authorization: Bearer …
Content-Type: application/json

{"room":"Peter's Room","targetC":22}
```

```http
POST /vents/room-target
Authorization: Bearer …
Content-Type: application/json

{"room":"Peter's Room","cancel":true}
```

```javascript
async function setVentRoomTarget(baseUrl, token, room, targetC) {
  const res = await fetch(`${baseUrl}/vents/room-target`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ room, targetC }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function cancelVentRoomTarget(baseUrl, token, room) {
  const res = await fetch(`${baseUrl}/vents/room-target`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ room, cancel: true }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
```

---

## `GET /vents/actions` — updated `rooms[]` fields

The handler and top-level shape are **unchanged**. Rows that already include vent fields (`motorId`, `wantOpen`, etc.) may also include:

| Field | Type | Description |
|-------|------|-------------|
| `roomTargetOverrideC` | number \| `null` | Active override setpoint (°C), or `null` if none / expired. |
| `roomTargetOverrideUntilMs` | number \| `null` | Epoch ms when the override expires; `null` if no active override. |

These fields appear only on rooms that are in **`roomVentMap`** (the same rows that have `motorId`, `pos`, `wantOpen`, …). Rooms listed only from sensors **without** a vent assignment **do not** include these keys.

**Semantics for `wantOpen`:** When `mode` is `cooling` or `heating`, `wantOpen` is computed using the **effective** band for that room — global `targets.coolTargetC` / `targets.heatTargetC` **or** the override `roomTargetOverrideC` for both edges, with `targets.roomHysteresisC` applied the same way as documented in [Vent-Dashboard.md](./Vent-Dashboard.md).

**Polling:** After `POST /vents/room-target`, refresh the dashboard (e.g. `GET /vents/actions`) to show updated `roomTargetOverride*` and `wantOpen`.

---

## UX hints

1. **Room picker** — Options should match **`roomVentMap`** keys (or derive from `rooms[]` rows that have `motorId`).
2. **Show expiry** — Use `roomTargetOverrideUntilMs` for a countdown or “until” label.
3. **Global vs room** — The **`targets`** object on `GET /vents/actions` remains the **global** config; do not assume it reflects per-room overrides.
4. **Mode flip** — If `mode` switches between cooling and heating, overrides may disappear on the next poll without an explicit cancel.

---

## Related code (contributors)

| File | Role |
|------|------|
| `devices/routes.config.js` | Registers `POST /vents/room-target` before `POST /vents/*/*`. |
| `devices/controllers/vents.controller.js` | `setRoomTarget` handler. |
| `devices/services/vent.automation.service.js` | Override storage, 20h TTL, `wantOpen` math, cooling↔heating bulk clear. |
