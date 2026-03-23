import http from 'http';
import express from 'express';
import cors from 'cors';
import WebSocket from 'ws';

type SensorConfig = {
  sensorId: number;
  sensorName: string;
  unit: string;
  minValue?: number;
  maxValue?: number;
};

type ReadingStatus = 'ok' | 'out_of_range';

type Reading = {
  sensorId: number;
  value: number;
  timestamp: string;
  status?: ReadingStatus;
  lastValidTimestamp?: string;
};

const app = express();
app.use(cors({ origin: true, credentials: false }));
app.use(express.json());

const EMULATOR_URL = process.env.EMULATOR_URL || 'http://localhost:3001';
const EMULATOR_HTTP_BASE = EMULATOR_URL.replace(/\/$/, '');

function emulatorWsUrl(httpBase: string): string {
  const wsBase = httpBase.startsWith('https://')
    ? httpBase.replace(/^https:\/\//, 'wss://')
    : httpBase.replace(/^http:\/\//, 'ws://');
  return `${wsBase}/ws/telemetry`;
}

const latestReadings = new Map<number, Reading>();
let emulatorWsConnected = false;
let lastEmulatorMessageAt: string | null = null;

const sensorRanges = new Map<number, { min: number; max: number }>();
const lastValidTimestamps = new Map<number, string>();

const FALLBACK_RANGES_BY_NAME = new Map<string, { min: number; max: number }>([
  ['BATTERY_TEMPERATURE', { min: 20, max: 80 }],
  ['MOTOR_TEMPERATURE', { min: 30, max: 120 }],
  ['BRAKE_PRESSURE_FRONT', { min: 0, max: 120 }],
  ['PACK_CURRENT', { min: -300, max: 300 }],
  ['PACK_SOC', { min: 0, max: 100 }],
  ['PACK_VOLTAGE', { min: 350, max: 500 }],
  ['STEERING_ANGLE', { min: -180, max: 180 }],
  ['TYRE_PRESSURE_FL', { min: 150, max: 250 }],
  ['TYRE_PRESSURE_FR', { min: 150, max: 250 }],
  ['TYRE_PRESSURE_RL', { min: 150, max: 250 }],
  ['TYRE_PRESSURE_RR', { min: 150, max: 250 }],
  ['VEHICLE_SPEED', { min: 0, max: 250 }]
]);

const oorEvents = new Map<number, number[]>();
const lastOorAlertAt = new Map<number, number>();
const OOR_WINDOW_MS = 5000;
const OOR_THRESHOLD = 3;
const OOR_ALERT_COOLDOWN_MS = 2000;

const invalidStats = {
  totalWsFrames: 0,
  parsedJsonFrames: 0,
  acceptedReadings: 0,
  fixedReadings: 0,
  droppedReadings: 0,
  reasons: {
    malformed_json: 0,
    missing_fields: 0,
    bad_sensorId: 0,
    bad_value: 0,
    bad_timestamp: 0
  }
};

type InvalidReason = keyof typeof invalidStats.reasons;

function bump(reason: InvalidReason) {
  invalidStats.reasons[reason] += 1;
  invalidStats.droppedReadings += 1;
}

function toFiniteNumber(x: unknown): number | null {
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (typeof x === 'string') {
    const s = x.trim();
    if (s.length === 0) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normalizeTimestamp(x: unknown): string | null {
  if (typeof x === 'string') {
    const d = new Date(x);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  if (typeof x === 'number') {
    const ms = x < 1e12 ? x * 1000 : x;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  return null;
}

let lastInvalidLogAt = 0;
const INVALID_LOG_COOLDOWN_MS = 1000;

function logInvalid(reason: InvalidReason, sample: unknown) {
  const now = Date.now();
  if (now - lastInvalidLogAt < INVALID_LOG_COOLDOWN_MS) return;
  lastInvalidLogAt = now;
  console.log(
    `[${new Date().toISOString()}] invalid telemetry dropped: ${reason} sample=${JSON.stringify(sample)}`
  );
}

function extractReading(payload: any): Reading | null {
  const p = payload?.reading ?? payload?.data ?? payload?.payload ?? payload;
  if (!p || typeof p !== 'object') {
    bump('missing_fields');
    logInvalid('missing_fields', payload);
    return null;
  }

  const rawSensorId = (p as any).sensorId;
  const rawValue = (p as any).value;
  const rawTs = (p as any).timestamp;

  if (rawSensorId === undefined || rawValue === undefined || rawTs === undefined) {
    bump('missing_fields');
    logInvalid('missing_fields', p);
    return null;
  }

  const sensorIdNum = toFiniteNumber(rawSensorId);
  if (sensorIdNum === null || !Number.isInteger(sensorIdNum)) {
    bump('bad_sensorId');
    logInvalid('bad_sensorId', p);
    return null;
  }

  const valueNum = toFiniteNumber(rawValue);
  if (valueNum === null) {
    bump('bad_value');
    logInvalid('bad_value', p);
    return null;
  }

  const tsIso = normalizeTimestamp(rawTs);
  if (tsIso === null) {
    bump('bad_timestamp');
    logInvalid('bad_timestamp', p);
    return null;
  }

  const fixed =
    typeof rawSensorId !== 'number' || typeof rawValue !== 'number' || typeof rawTs !== 'string';

  if (fixed) invalidStats.fixedReadings += 1;
  invalidStats.acceptedReadings += 1;

  return {
    sensorId: sensorIdNum,
    value: valueNum,
    timestamp: tsIso
  };
}

function attachStatusAndTrack(reading: Reading) {
  const range = sensorRanges.get(reading.sensorId);
  if (!range) return;

  const isOut = reading.value < range.min || reading.value > range.max;
  reading.status = isOut ? 'out_of_range' : 'ok';

  if (!isOut) {
    lastValidTimestamps.set(reading.sensorId, reading.timestamp);
    return;
  }

  reading.lastValidTimestamp = lastValidTimestamps.get(reading.sensorId);

  const now = Date.now();
  const arr = oorEvents.get(reading.sensorId) ?? [];
  arr.push(now);

  const cutoff = now - OOR_WINDOW_MS;
  while (arr.length > 0 && arr[0] < cutoff) arr.shift();

  oorEvents.set(reading.sensorId, arr);

  if (arr.length > OOR_THRESHOLD) {
    const last = lastOorAlertAt.get(reading.sensorId) ?? 0;
    if (now - last >= OOR_ALERT_COOLDOWN_MS) {
      lastOorAlertAt.set(reading.sensorId, now);
      console.log(
        `[${new Date().toISOString()}] out-of-range threshold exceeded for sensorId=${reading.sensorId} (${arr.length} events in ${OOR_WINDOW_MS}ms)`
      );
    }
  }
}

async function fetchSensors(): Promise<SensorConfig[]> {
  const r = await fetch(`${EMULATOR_HTTP_BASE}/sensors`);
  if (!r.ok) throw new Error(`Emulator /sensors returned ${r.status}`);

  const sensors = (await r.json()) as SensorConfig[];

  const enriched: SensorConfig[] = sensors.map((s) => {
    let minValue = s.minValue;
    let maxValue = s.maxValue;

    if (typeof minValue !== 'number' || typeof maxValue !== 'number') {
      const fb = FALLBACK_RANGES_BY_NAME.get(s.sensorName);
      if (fb) {
        minValue = fb.min;
        maxValue = fb.max;
      }
    }

    if (typeof minValue === 'number' && typeof maxValue === 'number') {
      sensorRanges.set(s.sensorId, { min: minValue, max: maxValue });
    }

    return {
      ...s,
      ...(typeof minValue === 'number' ? { minValue } : {}),
      ...(typeof maxValue === 'number' ? { maxValue } : {})
    };
  });

  return enriched;
}

function startEmulatorWsClient() {
  const url = emulatorWsUrl(EMULATOR_HTTP_BASE);

  const connect = () => {
    const ws = new WebSocket(url);

    ws.on('open', () => {
      emulatorWsConnected = true;
      console.log(`[api] connected to emulator WS: ${url}`);
    });

    let loggedExample = false;

    ws.on('message', (data) => {
      lastEmulatorMessageAt = new Date().toISOString();
      invalidStats.totalWsFrames += 1;

      try {
        const parsed = JSON.parse(data.toString());
        invalidStats.parsedJsonFrames += 1;

        if (!loggedExample) {
          console.log('[api] example ws payload:', JSON.stringify(parsed));
          loggedExample = true;
        }

        const reading = extractReading(parsed);
        if (reading) {
          attachStatusAndTrack(reading);
          latestReadings.set(reading.sensorId, reading);
        }
      } catch {
        invalidStats.reasons.malformed_json += 1;
        invalidStats.droppedReadings += 1;
      }
    });

    ws.on('close', () => {
      emulatorWsConnected = false;
      console.log('[api] emulator WS disconnected - retrying in 1s');
      setTimeout(connect, 1000);
    });

    ws.on('error', (err) => {
      emulatorWsConnected = false;
      console.log('[api] emulator WS error:', err.message);
      try {
        ws.close();
      } catch {}
    });
  };

  connect();
}

app.get('/health', async (_req, res) => {
  let emulatorHttpOk = false;

  try {
    const r = await fetch(`${EMULATOR_HTTP_BASE}/sensors`);
    emulatorHttpOk = r.ok;
  } catch {
    emulatorHttpOk = false;
  }

  if (!emulatorHttpOk) {
    return res.status(503).json({
      status: 'unhealthy',
      emulator: false,
      emulatorHttpOk,
      emulatorWsConnected,
      lastEmulatorMessageAt,
      invalidStats
    });
  }

  return res.json({
    status: 'ok',
    emulator: true,
    emulatorHttpOk,
    emulatorWsConnected,
    lastEmulatorMessageAt,
    readingsCached: latestReadings.size,
    invalidStats
  });
});

app.get('/sensors', async (_req, res) => {
  try {
    const sensors = await fetchSensors();
    res.json(sensors);
  } catch (e: any) {
    console.log('[api] /sensors error:', e?.message ?? e);
    res.status(503).json({ error: 'failed_to_fetch_sensors' });
  }
});

app.get('/telemetry', (_req, res) => {
  const readings = Array.from(latestReadings.values()).sort(
    (a, b) => a.sensorId - b.sensorId
  );

  res.json({ readings });
});

app.get('/telemetry/latest', (req, res) => {
  const q = req.query.sensorId;

  const filterIds: number[] =
    q === undefined
      ? []
      : Array.isArray(q)
      ? q.map((v) => Number(v)).filter((n) => Number.isFinite(n))
      : [Number(q)].filter((n) => Number.isFinite(n));

  const all = Array.from(latestReadings.values());
  const out = filterIds.length === 0 ? all : all.filter((r) => filterIds.includes(r.sensorId));

  res.json(out);
});

const server = http.createServer(app);

const PORT = process.env.PORT || 4000;
const HOST = process.env.HOST || '0.0.0.0';

server.listen(Number(PORT), HOST, async () => {
  console.log(`API server listening on http://${HOST}:${PORT}`);

  try {
    await fetchSensors();
    console.log('[api] sensor metadata loaded');
  } catch (e: any) {
    console.log('[api] failed to preload sensor metadata:', e?.message ?? e);
  }

  startEmulatorWsClient();
});
