import { connection } from "next/server";
import { investigationResponse } from "@/lib/investigation-stream";

/** One investigation run. The body is NDJSON progress, then one result line. */
export async function POST() {
  await connection();
  return investigationResponse();
}
