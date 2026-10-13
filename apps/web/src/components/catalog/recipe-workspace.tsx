'use client';

import type { CatalogComponent, CrateType, RecipeVersion } from '@ayvo/types';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { catalogCs } from '@/i18n/cs/catalog';
import { SuccessNote } from './form-kit';
import { RecipeActions } from './recipe-actions';
import { RecipeEditor } from './recipe-editor';

/**
 * A draft's editor and its lifecycle actions, sharing the "unsaved changes" state. The editor is
 * re-created for every revision the page loads (after a save, or "Načíst aktuální stav"), so it
 * never shows stale content next to fresh data.
 */
export function RecipeWorkspace(props: {
  recipe: RecipeVersion;
  components: CatalogComponent[];
  crateTypes: CrateType[];
  activeVersion: number | null;
  canManage: boolean;
  canApprove: boolean;
  productActive: boolean;
  editable: boolean;
  /** `?saved=<revision>` of the URL: survives the page re-rendering after a save. */
  savedRevision: number | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [dirty, setDirty] = useState(false);
  // Shown right after our own save and — through the URL — after the page re-renders (the
  // loading boundary may re-create this component); hidden by the next edit.
  const [saved, setSaved] = useState(false);
  const showSaved = (saved || props.savedRevision === props.recipe.revision) && !dirty;
  return (
    <div className="flex flex-col gap-6">
      <RecipeActions
        recipe={props.recipe}
        activeVersion={props.activeVersion}
        canManage={props.canManage}
        canApprove={props.canApprove}
        productActive={props.productActive}
        dirty={props.editable && dirty}
      />
      {props.editable && (
        <>
          {showSaved && (
            <div data-testid="recipe-saved">
              <SuccessNote>{catalogCs.recipe.saved}</SuccessNote>
            </div>
          )}
          <RecipeEditor
            key={`${props.recipe.version}:${props.recipe.revision}`}
            recipe={props.recipe}
            components={props.components}
            crateTypes={props.crateTypes}
            onDirtyChange={setDirty}
            onSaved={(revision) => {
              setSaved(true);
              router.replace(`${pathname}?saved=${revision}`, { scroll: false });
            }}
          />
        </>
      )}
    </div>
  );
}
