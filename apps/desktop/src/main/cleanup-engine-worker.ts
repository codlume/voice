import { createS1Mini } from "@voice/cleanup";

import { serve } from "./cleanup-engine.ts";

serve(process.parentPort, createS1Mini);
