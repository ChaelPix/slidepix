export type ExportResult =
  | { status: "success"; message: string }
  | { status: "cancelled" }
  | { status: "error"; message: string };
