import { DashboardApp } from "@/components/dashboard-app";
import { getCrmData } from "@/lib/crm-data";
import { getWorkspaceContext } from "@/lib/workspace";

// La sesión vive en cookies: el dashboard siempre se renderiza por request.
export const dynamic = "force-dynamic";
// Las Server Actions de esta página (registrar en Shalom o Swayp, traer
// estados) hablan con otros sistemas y pueden tardar más que el tope por
// defecto de la plataforma.
export const maxDuration = 60;

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ auth_error?: string; vista?: string; chat?: string; pedido?: string }>;
}) {
  const [context, params] = await Promise.all([getWorkspaceContext(), searchParams]);

  const data =
    context.status === "ready"
      ? await getCrmData(context.workspaceId, context.timezone, context.userId)
      : null;

  // `vista` es la sección abierta: viene en la URL para que un refresco deje
  // al usuario donde estaba en vez de mandarlo siempre al Resumen. Se resuelve
  // acá, en el servidor, así la primera pintura ya es la sección correcta.
  return (
    <DashboardApp
      context={context}
      data={data}
      authError={params.auth_error ?? null}
      vista={params.vista ?? null}
      chat={params.chat ?? null}
      pedido={params.pedido ?? null}
    />
  );
}
