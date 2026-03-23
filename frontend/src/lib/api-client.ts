export type SensorConfig = {
  sensorId: number;
  sensorName: string;
  unit: string;
  minValue?: number;
  maxValue?: number;
};

export type ReadingStatus = 'ok' | 'out_of_range';

export type Reading = {
  sensorId: number;
  value: number;
  timestamp: string;
  status?: ReadingStatus;
  lastValidTimestamp?: string;
};

export type HealthResponse = {
  status: 'ok' | 'unhealthy';
  emulator: boolean;
  emulatorHttpOk: boolean;
  emulatorWsConnected: boolean;
  lastEmulatorMessageAt: string | null;
  readingsCached?: number;
  invalidStats?: unknown;
};

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE?.replace(/\/$/, '') || 'http://localhost:4000';

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { cache: 'no-store' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GET ${path} failed: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

export function getApiBase() {
  return API_BASE;
}

export async function getSensors(): Promise<SensorConfig[]> {
  return apiGet<SensorConfig[]>('/sensors');
}

export async function getLatestTelemetry(sensorIds?: number[]): Promise<Reading[]> {
  if (!sensorIds || sensorIds.length === 0) return apiGet<Reading[]>('/telemetry/latest');

  const qs = sensorIds.map((id) => `sensorId=${encodeURIComponent(String(id))}`).join('&');
  return apiGet<Reading[]>(`/telemetry/latest?${qs}`);
}

export async function getHealth(): Promise<HealthResponse> {
  return apiGet<HealthResponse>('/health');
}
