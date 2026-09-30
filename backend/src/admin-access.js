/* KINGBOT FINTECH — central administrator identity helper */
export function isAdminEmail(email){
  const value=String(email||"").trim().toLowerCase();
  const admins=String(process.env.KINGBOT_ADMIN_EMAILS||process.env.ADMIN_EMAIL||"")
    .split(",")
    .map(x=>x.trim().toLowerCase())
    .filter(Boolean);
  return Boolean(value) && admins.includes(value);
}

export async function isAdminUser(pool,userId){
  if(!pool||!userId)return false;
  const q=await pool.query("SELECT email FROM kingbot_users WHERE id=$1 LIMIT 1",[userId]);
  return q.rowCount>0 && isAdminEmail(q.rows[0].email);
}
