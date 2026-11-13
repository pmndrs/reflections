// W72: the showcase frame with energy.js's rows outlined (door y 345-388, skirt y 396-438, x 560-720 at 1280x720).
P.stop();
await P.step(8);
const url = await P.shot();
const img = await new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = url; });
const c = new OffscreenCanvas(img.width, img.height); const g = c.getContext('2d'); g.drawImage(img, 0, 0);
const sx = img.width / 1280, sy = img.height / 720;
g.strokeStyle = '#0f0'; g.strokeRect(560 * sx, 345 * sy, 160 * sx, 43 * sy);
g.strokeStyle = '#f0f'; g.strokeRect(560 * sx, 396 * sy, 160 * sx, 42 * sy);
const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
const b64 = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
save('energy-regions.jpg', b64);
return [img.width, img.height];
