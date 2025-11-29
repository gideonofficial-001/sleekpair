const express = require("express");
const cors = require("cors");
const axios = require("axios");
const QRCode = require("qrcode");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

// Serve frontend
app.use(express.static("public"));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Pair code API endpoint
app.get("/generate", async (req, res) => {
  try {
    const response = await axios.get(
      "https://pairing.africans-devs.workers.dev/pair"
    );

    if (!response.data || !response.data.code) {
      return res.json({ status: "error", message: "Error fetching pair code" });
    }

    const pairCode = response.data.code;
    const qrCode = await QRCode.toDataURL(pairCode);

    res.json({
      status: "success",
      pairCode,
      qrCode,
    });
  } catch (error) {
    res.json({ status: "error", message: error.message });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
