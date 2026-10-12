import {
  createRoleRequestSchema,
  statusChangeRequestSchema,
  updateRoleRequestSchema,
  type CreateRoleRequest,
  type PermissionCatalog,
  type RoleCatalog,
  type RoleDetail,
  type StatusChangeRequest,
  type UpdateRoleRequest,
} from '@ayvo/types';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequirePermission } from './access.decorators.js';
import { CurrentPrincipal } from './access.guard.js';
import type { Principal } from './principal.js';
import { RolesService } from './roles.service.js';

const ID = new ParseUUIDPipe();

/** Roles and the permission catalogue (doc 021 §7a). Only ADMIN changes role definitions. */
@Controller(`${ADMIN_PREFIX}/identity`)
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get('permissions')
  @RequirePermission('identity:users_read')
  permissions(): Promise<PermissionCatalog> {
    return this.roles.permissions();
  }

  @Get('roles')
  @RequirePermission('identity:users_read')
  catalog(): Promise<RoleCatalog> {
    return this.roles.catalog();
  }

  @Get('roles/:id')
  @RequirePermission('identity:users_read')
  detail(@Param('id', ID) id: string): Promise<RoleDetail> {
    return this.roles.detail(id);
  }

  @Post('roles')
  @RequirePermission('identity:roles_manage')
  create(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(createRoleRequestSchema)) body: CreateRoleRequest,
  ): Promise<RoleDetail> {
    return this.roles.create(principal, body);
  }

  @Post('roles/:id')
  @HttpCode(200)
  @RequirePermission('identity:roles_manage')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ID) id: string,
    @Body(new ZodValidationPipe(updateRoleRequestSchema)) body: UpdateRoleRequest,
  ): Promise<RoleDetail> {
    return this.roles.update(principal, id, body);
  }

  @Post('roles/:id/deactivate')
  @HttpCode(200)
  @RequirePermission('identity:roles_manage')
  deactivate(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ID) id: string,
    @Body(new ZodValidationPipe(statusChangeRequestSchema)) body: StatusChangeRequest,
  ): Promise<RoleDetail> {
    return this.roles.deactivate(principal, id, body.reason);
  }

  @Post('roles/:id/reactivate')
  @HttpCode(200)
  @RequirePermission('identity:roles_manage')
  reactivate(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ID) id: string,
    @Body(new ZodValidationPipe(statusChangeRequestSchema)) body: StatusChangeRequest,
  ): Promise<RoleDetail> {
    return this.roles.reactivate(principal, id, body.reason);
  }
}
