declare module "qrcode" {
  const QRCode: { toDataURL(text: string): Promise<string> };
  export default QRCode;
}
