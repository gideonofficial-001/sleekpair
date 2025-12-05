let currentSessionId = null;

function showMsg(txt, isError = false) {
  const msg = document.getElementById("msg");
  msg.style.color = isError ? "red" : "lime";
  msg.innerText = txt;
}

function copyCode() {
  const text = document.getElementById("pairCode").innerText;
  if (!text) return alert("Nothing to copy.");

  navigator.clipboard.writeText(text);
  alert("Pair code copied to clipboard!");
}

async function generate() {
  const phone = document.getElementById("phone").value.trim();
  const token = document.getElementById("token").value.trim();

  const loader = document.getElementById("loader");
  const output = document.getElementById("output");

  showMsg("");

  // --- VALIDATION ---
  if (!/^[0-9]{10,15}$/.test(phone)) {
    return showMsg("Invalid phone number. Include country code only.", true);
  }

  if (!token) {
    return showMsg("Token required.", true);
  }

  loader.style.display = "block";
  output.style.display = "none";

  try {
    const res = await fetch(`/api/pair-code?phone=${phone}&token=${token}`);
    const data = await res.json();

    loader.style.display = "none";

    if (data.error) {
      showMsg(data.error, true);
      return;
    }

    document.getElementById("pairCode").innerText = data.pairCode;
    document.getElementById("qr").src = data.qrCode;
    document.getElementById("sessionId").innerText = data.sessionId;

    currentSessionId = data.sessionId;
    output.style.display = "block";

    showMsg("Pair code generated successfully!");

  } catch (err) {
    loader.style.display = "none";
    showMsg("Server connection error.", true);
  }
}

function downloadSession() {
  if (!currentSessionId) return alert("Generate code first.");

  const token = document.getElementById("token").value.trim();
  const url = `/api/download-session?sessionId=${currentSessionId}&token=${token}`;

  const a = document.createElement("a");
  a.href = url;
  a.download = `${currentSessionId}.zip`;
  a.click();
}