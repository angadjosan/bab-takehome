export default function Home() {
  return (
    <main>
      <h1>EnvMarket AI jurors</h1>
      <p>
        The three AI jurors for FalseDescription disputes on the RL Environment Market, running as Vercel Functions with durable Vercel
        Workflow runs (one per dispute). Operated by the marketplace operator.
      </p>
      <ul>
        <li>
          <a href="/api/health">GET /api/health</a>: juror addresses, stakes and balances read from the chain
        </li>
        <li>POST /api/wake: look for unhandled disputes and start a juror run for each</li>
      </ul>
    </main>
  );
}
