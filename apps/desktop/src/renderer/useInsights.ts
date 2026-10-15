import { useEffect, useState } from "react";

import type { Insights } from "../shared/insights.ts";
import { hubApi } from "./voice.ts";

export function useInsights(): Insights | null {
  const [insights, setInsights] = useState<Insights | null>(null);
  useEffect(() => {
    void hubApi().getInsights().then(setInsights);
    return hubApi().onInsights(setInsights);
  }, []);
  return insights;
}
