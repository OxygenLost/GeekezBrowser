function applyStableCanvasNoise(
    pixels,
    width,
    height,
    seed,
    channelNoise,
    originX = 0,
    originY = 0,
    canvasWidth = width
) {
    if (!pixels || typeof pixels.length !== 'number') return pixels;

    const regionWidth = Math.max(0, Math.trunc(Number(width) || 0));
    const regionHeight = Math.max(0, Math.trunc(Number(height) || 0));
    const sourceWidth = Math.max(regionWidth, Math.trunc(Number(canvasWidth) || regionWidth));
    const offsetX = Math.trunc(Number(originX) || 0);
    const offsetY = Math.trunc(Number(originY) || 0);
    const normalizedSeed = (Number(seed) || 1) >>> 0;
    const isCompactProbeCanvas = regionWidth <= 96 && regionHeight <= 32;
    const noise = channelNoise && typeof channelNoise === 'object' ? channelNoise : {};
    const deltas = ['r', 'g', 'b'].map((key) => {
        const value = Number(noise[key]);
        return Number.isFinite(value) ? Math.max(-5, Math.min(5, Math.trunc(value))) : 0;
    });
    if (deltas.every((value) => value === 0)) {
        deltas[normalizedSeed % 3] = (normalizedSeed & 1) === 0 ? 1 : -1;
    }

    const shiftChannel = (value, delta) => {
        if (!delta) return value;
        let next = Math.max(0, Math.min(255, value + delta));
        if (next === value) {
            next = Math.max(0, Math.min(255, value - delta));
        }
        return next;
    };

    for (let y = 0; y < regionHeight; y++) {
        for (let x = 0; x < regionWidth; x++) {
            const dataIndex = (y * regionWidth + x) * 4;
            if (dataIndex + 3 >= pixels.length || pixels[dataIndex + 3] === 0) continue;

            // Compact font-probe canvases use low-saturation glyph pixels.
            // Keep those pixels native across platforms because anti-aliasing
            // differs between Windows, macOS and Linux.
            if (isCompactProbeCanvas) {
                const red = pixels[dataIndex];
                const green = pixels[dataIndex + 1];
                const blue = pixels[dataIndex + 2];
                const spread = Math.max(red, green, blue) - Math.min(red, green, blue);
                if (spread <= 16) continue;
            }

            const globalX = offsetX + x;
            const globalY = offsetY + y;
            const pixelIndex = globalY * sourceWidth + globalX;
            let value = (normalizedSeed ^ Math.imul(pixelIndex + 1, 0x45d9f3b)) >>> 0;
            value ^= value >>> 16;
            value = Math.imul(value, 0x7feb352d);
            value ^= value >>> 15;
            value = Math.imul(value, 0x846ca68b);
            value ^= value >>> 16;
            if ((value >>> 0) % 31 !== 0) continue;

            pixels[dataIndex] = shiftChannel(pixels[dataIndex], deltas[0]);
            pixels[dataIndex + 1] = shiftChannel(pixels[dataIndex + 1], deltas[1]);
            pixels[dataIndex + 2] = shiftChannel(pixels[dataIndex + 2], deltas[2]);
        }
    }

    return pixels;
}

// Keep the sparse noise pattern from over-sampling the 80x10 canvas used by
// common font detectors. Larger canvases still receive the full noise density.
function countStableCanvasNoiseHits(seed, width = 80, height = 10) {
    const normalizedSeed = (Number(seed) || 1) >>> 0;
    const regionWidth = Math.max(0, Math.trunc(Number(width) || 0));
    const regionHeight = Math.max(0, Math.trunc(Number(height) || 0));
    let hits = 0;
    for (let pixelIndex = 0; pixelIndex < regionWidth * regionHeight; pixelIndex += 1) {
        let value = (normalizedSeed ^ Math.imul(pixelIndex + 1, 0x45d9f3b)) >>> 0;
        value ^= value >>> 16;
        value = Math.imul(value, 0x7feb352d);
        value ^= value >>> 15;
        value = Math.imul(value, 0x846ca68b);
        value ^= value >>> 16;
        if ((value >>> 0) % 31 === 0) hits += 1;
    }
    return hits;
}

function isStableCanvasNoiseSeed(seed) {
    const hits = countStableCanvasNoiseHits(seed);
    return hits >= 8 && hits <= 20;
}

module.exports = {
    applyStableCanvasNoise,
    countStableCanvasNoiseHits,
    isStableCanvasNoiseSeed
};
