import { createHash } from "node:crypto";
import { Entry } from "@napi-rs/keyring";

const value = new Entry(process.argv[2], process.argv[3]).getPassword();
// A second same-user process proves the trust boundary without printing a key.
process.stdout.write(value ? createHash("sha256").update(value).digest("hex") : "missing");
