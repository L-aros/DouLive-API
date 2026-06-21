module.exports = function healthHandler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });
  }

  return res.status(200).json({
    ok: true,
    service: 'doulive-api-vercel'
  });
};
