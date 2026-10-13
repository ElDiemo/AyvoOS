'use client';

import type { CatalogComponent, CrateType, RecipeVersion } from '@ayvo/types';
import { useState } from 'react';
import { RecipeActions } from './recipe-actions';
import { RecipeEditor } from './recipe-editor';

/** A draft's editor and its lifecycle actions, sharing the "unsaved changes" state. */
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
  return (
    <div className="flex flex-col gap-6">
      <RecipeActions
        recipe={props.recipe}
        activeVersion={props.activeVersion}
        canManage={props.canManage}
        canApprove={props.canApprove}
        productActive={props.productActive}
        dirty={dirty}
      />
      {props.editable && (
        <RecipeEditor
          recipe={props.recipe}
          components={props.components}
          crateTypes={props.crateTypes}
          onDirtyChange={setDirty}
        />
      )}
    </div>
  );
}
