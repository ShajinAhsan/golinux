import { ImageResponse } from "next/og";

export const dynamic = "force-static";
export const alt = "GoLinux — Ultra-lightweight Alpine Linux inside your browser";
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          backgroundColor: "#ffffff",
          color: "#1d1d1f",
          padding: "64px 72px",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          <div
            style={{
              width: "52px",
              height: "52px",
              borderRadius: "14px",
              backgroundColor: "#f5f5f7",
              border: "1px solid #d2d2d7",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "26px",
              fontWeight: 800,
              color: "#1d1d1f",
              marginRight: "16px",
            }}
          >
            &gt;_
          </div>
          <span
            style={{
              fontSize: "30px",
              fontWeight: 800,
              letterSpacing: "-0.03em",
              color: "#1d1d1f",
            }}
          >
            GoLinux
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              fontSize: "76px",
              fontWeight: 800,
              lineHeight: 1.02,
              letterSpacing: "-0.045em",
              color: "#1d1d1f",
              maxWidth: "980px",
              marginBottom: "24px",
            }}
          >
            A real Linux machine, right in your browser tab.
          </div>
          <div
            style={{
              fontSize: "28px",
              color: "#6e6e73",
              maxWidth: "860px",
              lineHeight: 1.4,
            }}
          >
            Alpine Linux in WebAssembly. Boots in under a second and runs 100%
            on your device.
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderTop: "1px solid #d2d2d7",
            paddingTop: "24px",
          }}
        >
          <span style={{ fontSize: "22px", color: "#6e6e73" }}>
            &lt;1s snapshot wake · ~5.1 MB snapshot · MIT open source
          </span>
          <span style={{ fontSize: "26px", fontWeight: 700, color: "#1d1d1f" }}>
            golinux.app
          </span>
        </div>
      </div>
    ),
    {
      ...size,
    }
  );
}
