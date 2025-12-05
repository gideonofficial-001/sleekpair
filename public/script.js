let currentSessionId = null;

// Your deployed backend URL
const BASE_URL = "https://sleekpair-2.onrender.com";

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
  // open format: 10–15 digits only, any country code allowed
  if (!/^[0-9]{10,15}$/.test(phone)) {
    return showMsg("Enter a valid phone number with country code.", true);
  }

  if (!token) {
    return showMsg("Token required.", true);
  }

  loader.style.display = "block";
  output.style.display = "none";

  try {
    const url = `${BASE_URL}/api/pair-code?phone=${phone}&token=${token}`;

    const res = await fetch(url);
    const data = await res.json();

    loader.style.display = "none";

    if (data.error) {
      showMsg(data.error, true);
      return;
    }

    // Populate results
    document.getElementById("pairCode").innerText = data.pairCode;
    document.getElementById("qr").src = data.qrCode;
    document.getElementById("sessionId").innerText = data.sessionId;

    currentSessionId = data.sessionId;
    output.style.display = "block";

    showMsg("Pair code generated successfully!");

  } catch (err) {
    loader.style.display = "none";
    showMsg("Unable to reach server.", true);
  }
}

function downloadSession() {
  if (!currentSessionId) return alert("Generate the code first.");

  const token = document.getElementById("token").value.trim();
  const url = `${BASE_URL}/api/download-session?sessionId=${currentSessionId}&token=${token}`;

  const a = document.createElement("a");
  a.href = url;
  a.download = `${currentSessionId}.zip`;
  a.click();
}