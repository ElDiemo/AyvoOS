'use client';

import type { CatalogComponent, CrateType, RecipeVersion } from '@ayvo/types';
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
}) {
  const [dirty, setDirty] = useState(false);
  const [savedRevision, setSavedRevision] = useState<number | null>(null);
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
          {savedRevision !== null && savedRevision <= props.recipe.revision && !dirty && (
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
            onSaved={() => setSavedRevision(props.recipe.revision + 1)}
          />
        </>
      )}
    </div>
  );
}
