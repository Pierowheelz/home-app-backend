# Vent automation — manual HVAC mode override (frontend API guide)

This document is for **frontend / app** authors integrating the **temporary HVAC mode correction** feature (force cooling ↔ heating when auto-detection is wrong). It complements [Vent-Dashboard.md](./Vent-Dashboard.md).

**Auth:** Same as other device routes: `Authorization: Bearer <JWT>` with **normal user** permission (see [API.md](./API.md)). Use `Content-Type: application/json` for POST bodies.

---

## Summary

| Change | Details |
|--------|---------|
| **New endpoint** | `POST /vents/hvac-mode` — set or cancel a temporary HVAC mode override. |
| **Updated response** | `GET /vents/actions` — may include **`hvacModeOverride`** and **`hvacModeOverrideUntilMs`**. |
| **Unchanged** | `GET /vents`, `POST /vents/:motorId/:percent`, `POST /vents/room-target`. |

Behavior (server-side):

- Accepts only **`cooling`** or **`heating`** (not `idle` — idle still comes from temperature / power).
- A **set** lasts **`ventAutomation.hvacModeOverrideDurationMs`** (default **1 hour**) from the successful request (`untilMs` in the response). Optional `duration` (ms) overrides that.
- Override is stored **in memory**; a **process restart** clears it.
- While active, the override wins over auto-detection for mode, **except** when a fresh HVAC power reading reports the unit as off — then `mode` stays **`idle`** so vents are not driven while the aircon is off.
- Setting a mode also updates the remembered last active direction used for power-based disambiguation after the override expires.
- A cooling ↔ heating flip (including via this override) still clears per-room target overrides, same as automatic flips.

---

## `POST /vents/hvac-mode`

**Purpose:** Force vent automation into cooling or heating, or cancel the override.

### Set a mode

**Body (JSON):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `mode` | string | Yes | Exactly `"cooling"` or `"heating"`. |
| `duration` | number | No | Override duration in **milliseconds**. Must be finite and ≥ 0 when present. |

**Success `200` JSON:**

| Field | Type | Description |
|-------|------|-------------|
| `success` | `true` | |
| `error` | `""` | |
| `mode` | string | Echo of accepted mode. |
| `durationMs` | number | Present only when `duration` was sent. |
| `untilMs` | number | Epoch ms when the override expires. |

**Error responses:**

| Status | `error` | When |
|--------|---------|------|
| `400` | `invalid_mode` | `mode` missing or not `"cooling"` / `"heating"`. |
| `400` | `invalid_duration` | `duration` present but not a finite number ≥ 0. |

After success, the server runs **one automation tick** from the current Zigbee snapshot.

### Cancel an override

**Body (JSON):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cancel` | boolean | Yes | Must be JSON boolean **`true`**. |

**Success `200` JSON:**

| Field | Type | Description |
|-------|------|-------------|
| `success` | `true` | |
| `error` | `""` | |
| `cancel` | `true` | |
| `hadActiveOverride` | boolean | `true` if an unexpired override was removed. |

### Examples

```http
POST /vents/hvac-mode
Authorization: Bearer …
Content-Type: application/json

{"mode":"heating"}
```

```http
POST /vents/hvac-mode
Authorization: Bearer …
Content-Type: application/json

{"mode":"cooling","duration":7200000}
```

```http
POST /vents/hvac-mode
Authorization: Bearer …
Content-Type: application/json

{"cancel":true}
```

```javascript
async function setVentHvacMode(baseUrl, token, mode, duration) {
  const body = duration === undefined ? { mode } : { mode, duration };
  const res = await fetch(`${baseUrl}/vents/hvac-mode`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function cancelVentHvacMode(baseUrl, token) {
  const res = await fetch(`${baseUrl}/vents/hvac-mode`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ cancel: true }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
```

---

## `GET /vents/actions` — override fields

| Field | Type | Description |
|-------|------|-------------|
| `hvacModeOverride` | `"cooling"` \| `"heating"` \| `null` | Active forced mode, or `null` if none / expired. |
| `hvacModeOverrideUntilMs` | number \| `null` | Epoch ms when the override expires; `null` if none. |

Top-level **`mode`** already reflects the effective mode (including override), so the UI can show a “manual” badge from `hvacModeOverride !== null` while still reading `mode` for vent logic.

**Polling:** After `POST /vents/hvac-mode`, refresh `GET /vents/actions` to show updated `mode`, override fields, and `wantOpen`.

---

## Related code (contributors)

| File | Role |
|------|------|
| `devices/routes.config.js` | Registers `POST /vents/hvac-mode` before `POST /vents/*/*`. |
| `devices/controllers/vents.controller.js` | `setHvacMode` handler. |
| `devices/services/vent.automation.service.js` | Override storage, TTL, mode resolution. |
