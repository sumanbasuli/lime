import { randomUUID } from "node:crypto";

// A fresh ID per new intended create/rescan/recheck action. Keep it for retries.
console.log(randomUUID());
