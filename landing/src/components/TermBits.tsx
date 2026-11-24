export function Prompt({ dir = "~" }: { dir?: string }) {
  return (
    <>
      <span className="font-semibold text-term-green">root@golinux</span>
      <span className="text-term-muted">:</span>
      <span className="font-semibold text-term-blue">{dir}</span>
      <span className="text-term-muted">#</span>{" "}
    </>
  );
}

export function WindowDots() {
  return (
    <div aria-hidden="true" className="flex items-center gap-1.5">
      <span className="size-2.5 rounded-full bg-[#ff5f56]" />
      <span className="size-2.5 rounded-full bg-[#ffbd2e]" />
      <span className="size-2.5 rounded-full bg-[#27c93f]" />
    </div>
  );
}
