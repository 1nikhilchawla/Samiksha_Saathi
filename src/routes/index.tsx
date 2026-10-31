import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Workspace } from "@/components/samiksha/workspace";
import { getCycle, getLive } from "@/lib/samiksha/api";
import { cycleKey, liveKey } from "@/lib/samiksha/view";

export const Route = createFileRoute("/")({
  // Server-rendered from the database, so the first paint already has the cycle.
  loader: async () => {
    const cycle = await getCycle({ data: {} });
    const live = await getLive({ data: {} });
    return { cycle, live };
  },
  component: Home,
});

function Home() {
  const data = Route.useLoaderData();
  const qc = useQueryClient();
  useState(() => {
    qc.setQueryData(cycleKey, data.cycle);
    qc.setQueryData(liveKey, data.live);
    return null;
  });
  return <Workspace />;
}
