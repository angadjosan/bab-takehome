export const metadata = { title: 'EnvMarket jurors' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, padding: '2rem 1rem', maxWidth: 720 }}>{children}</body>
    </html>
  );
}
