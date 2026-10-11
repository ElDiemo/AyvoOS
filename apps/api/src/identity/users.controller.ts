import {
  createUserRequestSchema,
  roleChangeRequestSchema,
  statusChangeRequestSchema,
  warehouseScopeRequestSchema,
  type AdminUserDetail,
  type AdminUserSummary,
  type CreateUserRequest,
  type RoleCatalog,
  type RoleChangeRequest,
  type StatusChangeRequest,
  type WarehouseScopeRequest,
} from '@ayvo/types';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequirePermission } from './access.decorators.js';
import { CurrentPrincipal } from './access.guard.js';
import type { Principal } from './principal.js';
import { UsersService } from './users.service.js';

const ID = new ParseUUIDPipe();

/** User and role administration (ADMIN). Every mutation needs a reason and is audited. */
@Controller(`${ADMIN_PREFIX}/identity`)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('roles')
  @RequirePermission('identity:users_read')
  roles(): Promise<RoleCatalog> {
    return this.users.roleCatalog();
  }

  @Get('warehouses')
  @RequirePermission('identity:users_read')
  warehouses() {
    return this.users.warehouses();
  }

  @Get('users')
  @RequirePermission('identity:users_read')
  list(): Promise<AdminUserSummary[]> {
    return this.users.list();
  }

  @Post('users')
  @RequirePermission('identity:users_manage')
  create(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(createUserRequestSchema)) body: CreateUserRequest,
  ): Promise<AdminUserDetail> {
    return this.users.create(principal.userId, body);
  }

  @Get('users/:id')
  @RequirePermission('identity:users_read')
  get(@Param('id', ID) id: string): Promise<AdminUserDetail> {
    return this.users.get(id);
  }

  @Post('users/:id/roles/grant')
  @HttpCode(200)
  @RequirePermission('identity:users_manage')
  grantRole(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ID) id: string,
    @Body(new ZodValidationPipe(roleChangeRequestSchema)) body: RoleChangeRequest,
  ) {
    return this.users.grantRole(principal.userId, id, body.role, body.reason);
  }

  @Post('users/:id/roles/revoke')
  @HttpCode(200)
  @RequirePermission('identity:users_manage')
  revokeRole(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ID) id: string,
    @Body(new ZodValidationPipe(roleChangeRequestSchema)) body: RoleChangeRequest,
  ) {
    return this.users.revokeRole(principal.userId, id, body.role, body.reason);
  }

  @Post('users/:id/warehouses/grant')
  @HttpCode(200)
  @RequirePermission('identity:users_manage')
  grantWarehouse(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ID) id: string,
    @Body(new ZodValidationPipe(warehouseScopeRequestSchema)) body: WarehouseScopeRequest,
  ) {
    return this.users.grantWarehouse(principal.userId, id, body.warehouseCode, body.reason);
  }

  @Post('users/:id/warehouses/revoke')
  @HttpCode(200)
  @RequirePermission('identity:users_manage')
  revokeWarehouse(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ID) id: string,
    @Body(new ZodValidationPipe(warehouseScopeRequestSchema)) body: WarehouseScopeRequest,
  ) {
    return this.users.revokeWarehouse(principal.userId, id, body.warehouseCode, body.reason);
  }

  @Post('users/:id/deactivate')
  @HttpCode(200)
  @RequirePermission('identity:users_manage')
  deactivate(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ID) id: string,
    @Body(new ZodValidationPipe(statusChangeRequestSchema)) body: StatusChangeRequest,
  ) {
    return this.users.deactivate(principal.userId, id, body.reason);
  }

  @Post('users/:id/reactivate')
  @HttpCode(200)
  @RequirePermission('identity:users_manage')
  reactivate(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ID) id: string,
    @Body(new ZodValidationPipe(statusChangeRequestSchema)) body: StatusChangeRequest,
  ) {
    return this.users.reactivate(principal.userId, id, body.reason);
  }
}
