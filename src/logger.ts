type LogLevel = "info" | "warn" | "error";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  [key: string]: unknown;
}

function log(level: LogLevel, message: string, data?: Record<string, unknown>) {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...data,
  };
  console.log(JSON.stringify(entry));
}

export const logger = {
  info: (message: string, data?: Record<string, unknown>) => log("info", message, data),
  warn: (message: string, data?: Record<string, unknown>) => log("warn", message, data),
  error: (message: string, data?: Record<string, unknown>) => log("error", message, data),
};