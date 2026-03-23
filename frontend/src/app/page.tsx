'use client';

import * as React from 'react';
import {
  getApiBase,
  getHealth,
  getLatestTelemetry,
  getSensors,
  type Reading,
  type SensorConfig
} from '@/lib/api-client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type Row = {
  sensorId: number;
  sensorName: string;
  unit: string;
  minValue?: number;
  maxValue?: number;
  value?: number;
  timestamp?: string;
  lastValidTimestamp?: string;
  status?: 'ok' | 'out_of_range';
};

function formatValue(value: number | undefined) {
  if (value === undefined) return '—';
  return Number.isFinite(value) ? value.toFixed(2) : '—';
}

function formatTime(ts: string | undefined) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return ts;
  return d.toLocaleString();
}

function timeAgo(ts: string | undefined) {
  if (!ts) return '—';
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return '—';
  const diffMs = Date.now() - t;
  if (!Number.isFinite(diffMs) || diffMs < 0) return '—';
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ago`;
}

function StatusBadge({ status }: { status?: Row['status'] }) {
  if (!status) return <Badge variant="secondary">unknown</Badge>;
  if (status === 'out_of_range') return <Badge variant="destructive">out of range</Badge>;
  return <Badge variant="default">ok</Badge>;
}

export default function Page() {
  const [sensors, setSensors] = React.useState<SensorConfig[]>([]);
  const [latest, setLatest] = React.useState<Reading[]>([]);
  const [health, setHealth] = React.useState<any>(null);

  const [query, setQuery] = React.useState('');
  const [onlyOutOfRange, setOnlyOutOfRange] = React.useState(false);

  const [loadingSensors, setLoadingSensors] = React.useState(true);
  const [loadingTelemetry, setLoadingTelemetry] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setLoadingSensors(true);
        const data = await getSensors();
        if (!alive) return;
        setSensors(data);
      } catch (e: any) {
        if (!alive) return;
        setError(e?.message ?? String(e));
      } finally {
        if (alive) setLoadingSensors(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  React.useEffect(() => {
    let alive = true;

    async function tick() {
      try {
        setLoadingTelemetry(true);
        const [h, t] = await Promise.all([
          getHealth().catch(() => null),
          getLatestTelemetry()
        ]);
        if (!alive) return;
        setHealth(h);
        setLatest(t);
        setError(null);
      } catch (e: any) {
        if (!alive) return;
        setError(e?.message ?? String(e));
      } finally {
        if (alive) setLoadingTelemetry(false);
      }
    }

    tick();
    const id = window.setInterval(tick, 1500);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  const rows: Row[] = React.useMemo(() => {
    const latestById = new Map<number, Reading>();
    for (const r of latest) latestById.set(r.sensorId, r);

    const base: Row[] = sensors.map((s) => {
      const r = latestById.get(s.sensorId);
      return {
        sensorId: s.sensorId,
        sensorName: s.sensorName,
        unit: s.unit,
        minValue: s.minValue,
        maxValue: s.maxValue,
        value: r?.value,
        timestamp: r?.timestamp,
        lastValidTimestamp: r?.lastValidTimestamp,
        status: r?.status
      };
    });

    base.sort((a, b) => {
      if (a.status === 'out_of_range' && b.status !== 'out_of_range') return -1;
      if (b.status === 'out_of_range' && a.status !== 'out_of_range') return 1;
      return a.sensorName.localeCompare(b.sensorName);
    });

    return base;
  }, [latest, sensors]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (onlyOutOfRange && r.status !== 'out_of_range') return false;
      if (!q) return true;
      return (
        String(r.sensorId).includes(q) ||
        r.sensorName.toLowerCase().includes(q) ||
        r.unit.toLowerCase().includes(q)
      );
    });
  }, [rows, query, onlyOutOfRange]);

  const apiBase = getApiBase();

  return (
    <div className="mx-auto max-w-6xl p-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">Telemetry Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            API: <span className="font-mono">{apiBase}</span>
          </p>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <Input
            placeholder="Search sensor name / id / unit"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-72"
          />
          <div className="flex items-center space-x-2">
            <Switch id="oor" checked={onlyOutOfRange} onCheckedChange={setOnlyOutOfRange} />
            <Label htmlFor="oor" className="text-sm">
              Out-of-range only
            </Label>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">System health</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span>API</span>
              <Badge variant={health?.status === 'ok' ? 'default' : 'destructive'}>
                {health?.status ?? 'unknown'}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span>Emulator HTTP</span>
              <Badge variant={health?.emulatorHttpOk ? 'default' : 'destructive'}>
                {health?.emulatorHttpOk ? 'ok' : 'fail'}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span>Emulator WS</span>
              <Badge variant={health?.emulatorWsConnected ? 'default' : 'destructive'}>
                {health?.emulatorWsConnected ? 'connected' : 'disconnected'}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span>Readings cached</span>
              <span className="font-mono">{health?.readingsCached ?? '—'}</span>
            </div>
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Sensors</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <div className="flex items-center justify-between mb-3">
              <div>
                <span className="font-mono">{filtered.length}</span> shown /{' '}
                <span className="font-mono">{rows.length}</span> total
              </div>
              <div className="text-muted-foreground">
                {loadingSensors || loadingTelemetry ? 'Updating…' : 'Live'}
              </div>
            </div>

            {error ? (
              <div className="rounded-md border p-3 text-sm">
                <div className="font-semibold mb-1">Error</div>
                <div className="font-mono text-xs whitespace-pre-wrap">{error}</div>
              </div>
            ) : null}

            <div className="rounded-md border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[220px]">Sensor</TableHead>
                    <TableHead>Value</TableHead>
                    <TableHead>Range</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-[220px]">Timestamp</TableHead>
                    <TableHead className="w-[220px]">Last valid timestamp</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loadingSensors && sensors.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-muted-foreground">
                        Loading sensors…
                      </TableCell>
                    </TableRow>
                  ) : filtered.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-muted-foreground">
                        No sensors match your filter.
                      </TableCell>
                    </TableRow>
                  ) : (
                    filtered.map((r) => (
                      <TableRow key={r.sensorId}>
                        <TableCell>
                          <div className="font-medium">{r.sensorName}</div>
                          <div className="text-xs text-muted-foreground font-mono">{r.sensorId}</div>
                        </TableCell>

                        <TableCell>
                          <span className="font-mono">{formatValue(r.value)}</span>
                          {r.unit ? <span className="ml-1 text-muted-foreground">{r.unit}</span> : null}
                        </TableCell>

                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {typeof r.minValue === 'number' && typeof r.maxValue === 'number'
                            ? `${r.minValue} … ${r.maxValue}`
                            : '—'}
                        </TableCell>

                        <TableCell>
                          <StatusBadge status={r.status} />
                        </TableCell>

                        <TableCell className="text-xs font-mono text-muted-foreground">
                          {formatTime(r.timestamp)}
                        </TableCell>

                        <TableCell className="text-xs font-mono text-muted-foreground">
                          {r.status === 'out_of_range' ? formatTime(r.lastValidTimestamp) : '—'}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>

            <div className="mt-3 text-xs text-muted-foreground">
              Polling telemetry every ~1.5s.
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
