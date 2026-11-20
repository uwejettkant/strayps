/** What can appear in the activity log. Front ends color an entry by its severity, not its type. */
export type ActivityEventType =
  | 'monitor-started'
  | 'scan-error'
  | 'config-reload'
  | 'process-alert'
  | 'process-recovered'
  | 'process-killed'
  | 'process-paused'
  | 'process-resumed';

export interface ActivityEvent {
  id: string;
  type: ActivityEventType;
  message: string;
  severity: 'info' | 'warn' | 'critical';
  timestamp: number;
}
