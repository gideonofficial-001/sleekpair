const express = require("express");
const app = express();
const QRCode = require("qrcode");

app.use(express.static(__dirname));

function generatePairCode() {
    return Math.random().toString(36).substring(2, 10).toUpperCase();
}

app.get("/generate", async (req, res) => {
    const pairCode = generatePairCode();
    const expiry = 60;

    const qrCode = await QRCode.toDataURL(pairCode);

    res.json({
        pairCode,
        qrCode,
        expiry
    });
});

app.listen(3000, () => console.log("SleekPair running on port 3000"));
