let currentSessionId = null;

async function generate() {
  const phone = document.getElementById("phone").value.trim();
  const token = document.getElementById("token").value.trim();
  const loader = document.getElementById("loader");
  const output = document.getElementById("output");

  if (!phone) return alert("Enter phone number.");
  if (!token) return alert("Enter token.");

  loader.style.display = "block";
  output.style.display = "none";

  try {
    const res = await fetch(`/api/pair-code?phone=${phone}&token=${token}`);
    const data = await res.json();

    loader.style.display = "none";

    if (data.error) {
      alert(data.error);
      return;
    }

    document.getElementById("pairCode").innerText = data.pairCode;
    document.getElementById("qr").src = data.qrCode;
    document.getElementById("sessionId").innerText = data.sessionId;

    currentSessionId = data.sessionId;
    output.style.display = "block";

  } catch (err) {
    loader.style.display = "none";
    alert("Server error. Check logs.");
  }
}

function downloadSession() {
  if (!currentSessionId) return alert("Generate a session first.");

  const token = document.getElementById("token").value.trim();
  const url = `/api/download-session?sessionId=${currentSessionId}&token=${token}`;

  const a = document.createElement("a");
  a.href = url;
  a.download = `${currentSessionId}.zip`;
  a.click();
}
