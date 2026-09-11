import type { NextConfig } from 'next';
import { withWorkflow } from 'workflow/next';

const nextConfig: NextConfig = {
  // The juror service has no pages to speak of; keep the server output lean.
  poweredByHeader: false,
};

export default withWorkflow(nextConfig);
