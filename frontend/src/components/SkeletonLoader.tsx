export function SkeletonLoader() {
  return (
    <div className="animate-pulse space-y-6">
      {/* Risk banner skeleton */}
      <div className="h-20 rounded-2xl bg-neutral-200" />

      {/* Portfolio summary skeleton */}
      <div className="rounded-2xl border border-neutral-200 bg-white p-5">
        <div className="space-y-4">
          <div className="h-4 w-24 bg-neutral-200 rounded" />
          <div className="h-8 w-32 bg-neutral-200 rounded" />
          <div className="flex gap-4">
            <div className="h-4 w-20 bg-neutral-200 rounded" />
            <div className="h-4 w-20 bg-neutral-200 rounded" />
          </div>
        </div>
      </div>

      {/* Coin cards skeleton */}
      <div className="space-y-4">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="rounded-2xl border border-neutral-200 bg-white p-5"
          >
            <div className="flex justify-between items-start mb-4">
              <div className="h-6 w-16 bg-neutral-200 rounded" />
              <div className="h-6 w-14 bg-neutral-200 rounded" />
            </div>
            <div className="space-y-2">
              <div className="h-4 w-full bg-neutral-200 rounded" />
              <div className="h-4 w-3/4 bg-neutral-200 rounded" />
              <div className="h-4 w-1/2 bg-neutral-200 rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
