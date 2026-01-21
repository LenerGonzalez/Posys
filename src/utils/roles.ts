export type Role =
  | "admin"
  | "supervisor_pollo"
  | "contador"
  | "vendedor_pollo"
  | "vendedor_ropa"
  | "vendedor_dulces"
  | "vendedor";

export function hasRole(
  rolesOrRole: Role | Role[] | string | string[] | undefined | null,
  roleToCheck: Role | string,
) {
  if (!rolesOrRole) return false;
  const desired = String(roleToCheck);
  if (Array.isArray(rolesOrRole))
    return rolesOrRole.map(String).includes(desired);
  const r = String(rolesOrRole);
  if (r === desired) return true;
  // compatibility: old "vendedor" means pollo
  if (r === "vendedor" && desired === "vendedor_pollo") return true;
  return false;
}
