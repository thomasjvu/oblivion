import { useEffect, useMemo } from 'react';
import { Navigate, useParams } from 'react-router-dom';

import DocPageFooter from '../components/DocPageFooter';
import DocumentationPage from '../components/docs/DocumentationPage';
import OpenApiReference from '../components/OpenApiReference';
import OpenApiSpecSelector from '../components/OpenApiSpecSelector';
import { openapiConfig } from '../../shared/documentation-config.js';
import { applySeoMetadata } from '../utils/seo';

const SITE_NAME = import.meta.env.VITE_SITE_NAME || 'papers';

export default function OpenApiPage() {
  const { specId } = useParams();
  const specs = openapiConfig.enabled ? openapiConfig.specs : [];
  const activeSpec = useMemo(() => {
    const requested = specs.find((spec) => spec.id === specId);
    if (requested) {
      return requested;
    }

    return specs.find((spec) => spec.id === openapiConfig.defaultSpecId) || specs[0] || null;
  }, [specId, specs]);

  useEffect(() => {
    if (!activeSpec) {
      return;
    }

    applySeoMetadata({
      title: `${activeSpec.label} | ${SITE_NAME}`,
      description: activeSpec.description || `Interactive OpenAPI reference for ${activeSpec.label}.`,
      path:
        activeSpec.id === openapiConfig.defaultSpecId
          ? '/docs/developers/openapi'
          : `/docs/developers/openapi/${activeSpec.id}`,
      canonicalPath:
        activeSpec.id === openapiConfig.defaultSpecId
          ? '/docs/developers/openapi'
          : `/docs/developers/openapi/${activeSpec.id}`,
      type: 'article',
    });
  }, [activeSpec]);

  if (specId && !activeSpec) {
    return <Navigate to="/docs/developers/openapi" replace />;
  }

  if (!activeSpec) {
    return <Navigate to="/docs/developers/api-reference" replace />;
  }

  return (
    <DocumentationPage
      initialContent=""
      currentPath="developers/openapi"
      contentSlot={
        <div className="doc-content pt-8 pb-6 px-6 md:pt-12 md:pb-8 md:px-8 lg:pt-16 lg:pb-12 lg:px-12 max-w-6xl mx-auto">
          <header className="mb-6">
            <h1 className="text-2xl font-bold mb-2" style={{ color: 'var(--text-color)' }}>
              {activeSpec.label}
            </h1>
            <p className="text-sm" style={{ color: 'var(--muted-color)' }}>
              {activeSpec.description || 'Interactive OpenAPI explorer.'} For integration flow and
              trust boundaries, see the{' '}
              <a href="/docs/developers/partner-api" style={{ color: 'var(--primary-color)' }}>
                Partner API guide
              </a>
              .
            </p>
          </header>

          <OpenApiSpecSelector
            specs={specs}
            activeSpecId={activeSpec.id}
            defaultSpecId={openapiConfig.defaultSpecId}
          />

          <OpenApiReference specUrl={activeSpec.url} />
          <DocPageFooter
            path="developers/openapi"
            sourcePath="src/docs/content/developers/openapi.md"
          />
        </div>
      }
    />
  );
}