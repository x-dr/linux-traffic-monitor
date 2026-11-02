import { Type, type Static } from '@sinclair/typebox';

export const reportIntervalOptions = [1, 3, 5, 10, 15] as const;
export const ReportIntervalSchema = Type.Union(reportIntervalOptions.map(value => Type.Literal(value)));
export type ReportInterval = Static<typeof ReportIntervalSchema>;
export type ReportingView = {
  interval_seconds: ReportInterval;
  supported: boolean;
  config_version: number;
  applied_version: number;
  error: string | null;
};
