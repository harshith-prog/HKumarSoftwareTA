# Vehicle Analytics Fullstack Assessment – Justification

## API

Use this file to briefly explain your design decisions. Bullet points are fine.

### 1. Overall API design

- Summary of your API structure and main routes (paths, methods, and what they return):

Overall API Design

When designing this API, my main goal was to keep the contract simple, predictable, and safe. The emulator is treated as an unreliable external source, so the API acts as a protective layer between it and any frontend client.

I separated the API into two main concerns:

static sensor metadata

dynamic sensor readings

This makes it clear what changes frequently (telemetry) and what does not (sensor configuration).

GET /metadata

This endpoint returns the full list of sensors, including:

sensorId

sensorName

unit

minValue

maxValue (if defined)

I expect clients to call this once when the application loads. Since metadata does not change frequently, it does not need to be polled repeatedly.

The response shape is:

{
  "sensors":[ ... ]
}

I used an array because the frontend can directly map over it. Keeping it flat avoids unnecessary nesting and makes it easier to render tables or cards.

GET /readings/latest

This endpoint returns the most recent valid reading per sensor.

Each reading includes:

sensorId

value

timestamp

status ("ok" or "out_of_range")

The status field is calculated by the API instead of the frontend. I chose to do this because range validation is part of business logic, not presentation logic. This keeps the frontend simpler and ensures consistency across clients.

The response shape is:

{
  "readings":[ ... ]
}

Again, this is an array to make frontend rendering straightforward.

### 2. Data vs metadata separation

- How clients should use your metadata route(s) vs your data route(s) (and streaming, if implemented):
The intended usage pattern is:

Call /metadata once at startup.

Then either:

Poll /readings/latest at a fixed interval (simple and reliable), or

Use a streaming endpoint if implemented.

Polling was chosen as the default assumption because it is easier to debug and works well for moderate update rates. Streaming can be added later if lower latency is needed.


### 3. Emulator (read-only)

- Confirm you did not modify the emulator service (`emulator/`) or its `sensor-config.json`. If you needed to work around anything, note it here: y/N
I confirm that I did not modify the emulator/ service or its sensor-config.json.

The emulator was treated as a fixed, external component. All validation, filtering, and error-handling logic were implemented in the API layer instead.

If there were any inconsistencies in incoming telemetry, they were handled defensively within the API (e.g., dropping malformed readings or coercing safe numeric strings), rather than changing the emulator configuration.

Workaround required: No.

### 4. OpenAPI / Swagger

- Where your final OpenAPI spec lives and how to view or use it (e.g. Swagger UI):
The final OpenAPI 3.x spec is located at api/openapi.yaml.

It can be viewed by:

Opening the file in Swagger Editor, or

Loading it into Swagger UI if configured.

The spec documents the implemented routes (/health, /sensors, /telemetry) including response schemas and status values.

The purpose of including an OpenAPI spec is to clearly define:

request paths

response schemas

expected status codes

This makes the API self-documenting and easier to test.


### 5. Testing and error handling

- What you chose to test and any notable error-handling decisions:
Since the emulator is treated as an external system, I assumed that incoming data may be malformed or inconsistent.

My error-handling strategy follows three rules:

The API must never crash because of emulator input.

Invalid readings must never reach the frontend.

Failures should be observable but not noisy.

All incoming telemetry is validated before being stored. If a reading fails validation, it is dropped immediately.

The API continues serving the last known valid readings even if new telemetry is invalid or temporarily unavailable.

### 6. Invalid data from the emulator (Task 2)

- How you detect invalid readings from the emulator stream:
- What you do with invalid data (drop, log, count, etc.) and why:
How invalid readings are detected

A reading is considered invalid if:

Required fields are missing.

sensorId is not a finite number.

value cannot be parsed into a finite number.

timestamp is missing or invalid.

If value is a numeric string (for example "92.5"), it is safely converted into a number. However, ambiguous values are not coerced.

What happens to invalid readings

Invalid readings are:

Dropped immediately.

Counted in an internal invalid counter.

Logged using throttled console logging to avoid spam during bursts.

They are never forwarded to /readings/latest.

I chose this approach because silently forwarding bad data would make debugging harder and could break frontend assumptions. Dropping invalid data keeps the API contract clean and predictable.

### 7. Out-of-range values per sensor (Task 3)

- How you use the valid-range table (sensor name or sensorId → min/max) and count out-of-range readings per sensor in a 5-second window:
- How you log the timestamp and error message (including sensor) when a sensor exceeds the threshold (&gt;3 out-of-range in 5 s):
Valid Range Table

The valid range for each sensor is derived from metadata (minValue and maxValue). These are stored in a lookup table keyed by sensorId.

A reading is marked as "out_of_range" if:

value < minValue, or

value > maxValue.

If a sensor has no defined range, it is treated as valid by default because no constraint exists.

“More than 3 out-of-range events in 5 seconds” Rule

For each sensor, I maintain a small in-memory sliding window of timestamps representing recent out-of-range events.

When a new out-of-range reading arrives:

Its timestamp is added to that sensor’s window.

Any timestamps older than 5 seconds are removed.

If the window size exceeds 3 events, a console message is triggered.

The log includes:

the current ISO timestamp

the sensorId

To prevent excessive console output during sustained faults, I implemented a cooldown period per sensor. This ensures repeated violations do not flood the logs.

This design isolates detection per sensor and avoids cross-sensor interference.

Design Trade-offs
Polling vs WebSocket

Polling is simpler and more robust. It works well for most frontend use cases and is easier to reason about during debugging.

WebSockets reduce latency but introduce additional complexity such as connection lifecycle management and reconnection handling.

Given the assignment scope, polling is sufficient.

Strict Rejection vs Flexible Coercion

I decided to:

Strictly reject malformed structures.

Allow safe coercion of obvious numeric strings.

This balances robustness with practicality. Completely strict validation could discard recoverable values, while overly flexible handling could hide data issues.

In-Memory State vs Persistence

All range tracking and sliding windows are implemented using in-memory maps.

This is appropriate because:

The assignment does not require persistence.

The system runs as a single-node process.

Performance and simplicity are prioritized.

If historical analysis were required, a database-backed solution would be more appropriate.


## Frontend

Use this section to briefly explain your frontend design decisions. Bullet points are fine.

### 1. Figma mockup

- Link to your low-fidelity Figma mockup and what it shows:
https://www.figma.com/design/tFqjRWQ7TP9cc9v5nDqSAA/Redback-Racing-Telemetry-%E2%80%93-Low-Fidelity?node-id=0-1&t=bSonKY91crdzTBjj-1

### 2. Layout and information hierarchy

- Why you structured the dashboard the way you did:
When structuring the dashboard, I focused on what a user would need to see first in a telemetry system. The most important information is the current state of the car’s sensors, so the majority of the screen is dedicated to live sensor readings.

The connection status is placed at the top of the screen because it affects everything else. If the system is disconnected, the user immediately understands why no data is being shown. This avoids confusion and makes the interface feel more transparent.

The sensor readings are displayed as individual cards in a grid. I chose a card layout because it keeps each sensor visually separate and makes the page easier to scan. Instead of placing everything in a long list, the grid format allows users to quickly compare values side by side.

Alerts are separated into a panel on the right. I didn’t want fault messages mixed in with live readings because that can become messy when data updates frequently. By isolating alerts, it becomes clearer when something abnormal is happening.

Overall, the structure follows a simple principle: global system state at the top, live data in the centre, and exceptions (alerts) on the side.

### 3. API consumption

- How you use `/sensors` and `/telemetry` (and WebSocket, if used):
The frontend uses two main endpoints.

The /sensors endpoint is called once when the dashboard loads. It provides the metadata such as sensor names, units, and valid ranges. Since this data doesn’t change often, there is no need to request it repeatedly.

The /telemetry endpoint is used to fetch the latest sensor readings. The dashboard polls this endpoint at a fixed interval (for example, every two seconds). Each response includes the value, timestamp, and the computed status (ok or out_of_range). I deliberately kept the validation logic in the API so the frontend does not need to reimplement range checks.

If WebSocket streaming is enabled, it can replace polling. In that case, the frontend subscribes once and updates the sensor cards as messages are received. However, polling was chosen as the baseline because it is simpler and easier to debug.

This approach keeps responsibilities clear: the backend validates and processes data, while the frontend focuses on displaying it.

### 4. Visual design and usability

- Choices around colours, typography, states, and responsiveness:
Since this is a low-fidelity mockup, I intentionally kept the design simple and neutral. The goal was to show structure and layout rather than final styling.

The card layout makes it easier to read individual sensor values without overwhelming the user. Each card clearly shows the sensor name, the current value, its status, and the last updated time. I avoided relying only on colour to indicate status, since explicit labels are more accessible and clearer in a wireframe.

The disconnected state is also handled explicitly. Instead of showing empty cards, the layout replaces the grid with a clear message explaining that telemetry data is unavailable. This avoids ambiguity and improves usability.

Spacing and alignment were kept consistent to make the layout feel structured and predictable. Even though this is low fidelity, maintaining visual balance improves readability.

### 5. Trade-offs and limitations

- Anything you would do with more time or a different stack:
There are a few trade-offs in this design.

First, polling was used instead of fully relying on WebSockets. Polling is simpler and reliable for this scope, but it is not as efficient as streaming updates. With more time, I would prioritise a WebSocket-driven design for lower latency.

Second, the dashboard only displays the most recent value for each sensor. There is no historical graph or trend view. In a real racing telemetry system, historical data would be extremely important for analysis. Adding small charts or drill-down views would be a natural extension.

Third, the UI is intentionally minimal. There is no colour-coding, branding, or advanced interaction. This was done because the focus of this task was layout and system behaviour rather than visual polish.

If I had more time, I would improve responsiveness for smaller screens, add filtering options for alerts, and include more advanced visual indicators for abnormal conditions.
