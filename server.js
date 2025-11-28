const express = require("express");
const QRCode = require("qrcode");

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/pair", async (req, res) => {
    const fakePairCode = "PAIR-" + Math.random().toString(36).substring(2, 10).toUpperCase();
    const qr = await QRCode.toDataURL(fakePairCode);

    res.json({
        status: "success",
        pairCode: fakePairCode,
        qrCode: qr
    });
});

app.listen(PORT, () => console.log(`Pair code server running on port ${PORT}`));