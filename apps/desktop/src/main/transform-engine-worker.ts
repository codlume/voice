import { createTransformEngine } from "@voice/cleanup/transform";

import { serve } from "./transform-engine.ts";

serve(process.parentPort, createTransformEngine);
