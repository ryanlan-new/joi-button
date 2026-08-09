// SPDX-License-Identifier: MIT

// The only identity used by the assembled local-development server. Keeping the
// value in one module prevents the public /api/me answer and the admin gate from
// drifting apart.
export const DEV_ADMIN_OPEN_ID = 'local-dev-admin'
export const DEV_ADMIN_DISPLAY_NAME = 'Local development'
