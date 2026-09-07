"use client";

import dynamic from "next/dynamic";

const Shell = dynamic(
  () => import("@/components/streaming/Shell").then((m) => m.Shell),
  {
    ssr: false,
    loading: () => (
      <div className="flex min-h-screen items-center justify-center bg-[#0a0a0f]">
        <div className="flex flex-col items-center gap-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-red-600 text-3xl font-black text-white shadow-2xl shadow-red-600/40 animate-pulse">
            S
          </div>
          <div className="h-1.5 w-40 overflow-hidden rounded-full bg-zinc-800">
            <div className="h-full w-1/2 animate-pulse rounded-full bg-red-600" />
          </div>
          <p className="text-xs tracking-widest text-zinc-500 uppercase">StreamVerse se încarcă...</p>
        </div>
      </div>
    ),
  }
);

export default function Page() {
  return <Shell />;
}
