export default function Footer() {
  return (
    <footer
      style={{
        borderTop: "1px solid #1a1a1a",
        padding: "16px 24px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: "8px",
      }}
    >
      <span style={{ fontSize: "11px", color: "#333" }}>
        Inference Studio — self-hosted AI inference
      </span>

      <a
        href="https://attest.97115104.com/s/cy1a0o3x"
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          fontSize: "11px",
          color: "#444",
          textDecoration: "none",
          border: "1px solid #222",
          padding: "3px 8px",
          borderRadius: "2px",
          transition: "color 0.15s, border-color 0.15s",
        }}
        onMouseOver={e => {
          e.currentTarget.style.color = "#ccff00";
          e.currentTarget.style.borderColor = "rgba(204,255,0,0.3)";
        }}
        onMouseOut={e => {
          e.currentTarget.style.color = "#444";
          e.currentTarget.style.borderColor = "#222";
        }}
      >
        <span style={{ color: "#ccff00", fontSize: "10px" }}>✦</span>
        Built with Claude Sonnet 4.6
      </a>
    </footer>
  );
}
