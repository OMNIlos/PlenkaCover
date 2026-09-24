import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { createOpenApiDocument } from '../src/openapi';

describe('OpenAPI document (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
  });

  afterAll(async () => {
    await app.close();
  });

  it('builds the production document with secured commercial routes', () => {
    const document = createOpenApiDocument(app);
    const listOrders = document.paths['/api/commercial/orders']?.get;
    const rawMaterials = document.paths['/api/commercial/raw-materials']?.get;

    expect(document.components?.securitySchemes?.session).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    expect(listOrders?.responses).toEqual(
      expect.objectContaining({ '200': expect.any(Object), '401': expect.any(Object) }),
    );
    expect(listOrders?.security).toContainEqual({ session: [] });
    expect(rawMaterials?.security).toContainEqual({ session: [] });
  });

  it('documents the capability-gated exact safe operational-problem route', () => {
    const document = createOpenApiDocument(app);
    const operation = document.paths['/api/commercial/performance/problems/{problemId}']?.get;
    const schema = document.components?.schemas?.BusinessOperationalProblemResponseDto as
      | { required?: string[]; properties?: Record<string, unknown> }
      | undefined;

    expect(operation).toBeDefined();
    expect(operation?.security).toContainEqual({ session: [] });
    expect(operation?.responses).toEqual(
      expect.objectContaining({
        '200': expect.objectContaining({
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/BusinessOperationalProblemResponseDto' },
            },
          },
        }),
        '401': expect.any(Object),
        '403': expect.any(Object),
        '404': expect.any(Object),
      }),
    );
    expect(schema?.required?.sort()).toEqual(
      [
        'createdAt',
        'id',
        'kind',
        'label',
        'machineName',
        'orderId',
        'orderNumber',
        'reason',
        'rollCode',
        'status',
      ].sort(),
    );
    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual(
      [
        'createdAt',
        'id',
        'kind',
        'label',
        'machineName',
        'orderId',
        'orderNumber',
        'reason',
        'rollCode',
        'status',
      ].sort(),
    );
  });

  it('documents the shared role inbox contract for every contour', () => {
    const document = createOpenApiDocument(app);
    const contourPaths = [
      '/api/commercial/notifications',
      '/api/finance/notifications',
      '/api/production/notifications',
      '/api/operator/notifications',
      '/api/warehouse/notifications',
      '/api/director/notifications',
      '/api/admin/notifications',
    ];

    for (const path of contourPaths) {
      const list = document.paths[path]?.get;
      const markRead = document.paths[`${path}/{eventId}/read`]?.put;

      expect(list).toBeDefined();
      expect(list?.security).toContainEqual({ session: [] });
      expect(list?.responses).toEqual(
        expect.objectContaining({
          '200': expect.objectContaining({
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/RoleInboxPageResponseDto' },
              },
            },
          }),
          '400': expect.any(Object),
          '401': expect.any(Object),
          '403': expect.any(Object),
        }),
      );

      expect(markRead).toBeDefined();
      expect(markRead?.security).toContainEqual({ session: [] });
      expect(markRead?.responses).toEqual(
        expect.objectContaining({
          '200': expect.objectContaining({
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/RoleInboxReadResponseDto' },
              },
            },
          }),
          '400': expect.any(Object),
          '401': expect.any(Object),
          '403': expect.any(Object),
          '404': expect.any(Object),
        }),
      );
    }

    expect(document.components?.schemas?.RoleInboxPageResponseDto).toEqual(
      expect.objectContaining({
        type: 'object',
        required: expect.arrayContaining(['items', 'nextCursor']),
        properties: expect.objectContaining({
          items: {
            type: 'array',
            items: { $ref: '#/components/schemas/RoleInboxItemResponseDto' },
          },
          nextCursor: { type: 'string', nullable: true },
        }),
      }),
    );
  });

  it('documents the safe warehouse-cover request result instead of a raw resolution case', () => {
    const document = createOpenApiDocument(app);
    const operation =
      document.paths['/api/commercial/orders/{orderId}/warehouse-cover/recheck']?.post;

    expect(operation?.responses?.['201']).toEqual(
      expect.objectContaining({
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/WarehouseCoverRequestResponseDto' },
          },
        },
      }),
    );
    const caseSchema = document.components?.schemas?.WarehouseCoverRequestCaseResponseDto as
      | { required?: string[]; properties?: Record<string, unknown> }
      | undefined;
    expect(caseSchema).toEqual(
      expect.objectContaining({
        required: expect.arrayContaining([
          'id',
          'orderId',
          'state',
          'ownerRole',
          'affectedPositionIds',
          'requestedAt',
          'updatedAt',
        ]),
      }),
    );
    expect(caseSchema?.properties).not.toHaveProperty('openScopeKey');
    expect(caseSchema?.properties).not.toHaveProperty('reason');
    expect(caseSchema?.properties).not.toHaveProperty('createdById');
  });

  it('documents warehouse rolls with the runtime safe response DTO', () => {
    const document = createOpenApiDocument(app);
    const operation = document.paths['/api/warehouse/rolls']?.get;

    expect(operation?.responses?.['200']).toEqual(
      expect.objectContaining({
        content: {
          'application/json': {
            schema: {
              type: 'array',
              items: { $ref: '#/components/schemas/WarehouseRollResponseDto' },
            },
          },
        },
      }),
    );
    const schema = document.components?.schemas?.WarehouseRollResponseDto as
      | { required?: string[]; properties?: Record<string, unknown> }
      | undefined;
    expect(schema?.required).toEqual(
      expect.arrayContaining(['id', 'rollCode', 'warehouseStatus', 'facts']),
    );
    expect(schema?.properties).toEqual(
      expect.objectContaining({
        facts: { $ref: '#/components/schemas/WarehouseRollFactsResponseDto' },
      }),
    );
    const factsSchema = document.components?.schemas?.WarehouseRollFactsResponseDto as
      | { required?: string[]; properties?: Record<string, unknown> }
      | undefined;
    expect(factsSchema?.required).toEqual(
      expect.arrayContaining([
        'filmType',
        'actualThickness',
        'birka',
        'spoolType',
        'plannedWeightKg',
      ]),
    );
    for (const forbidden of [
      'positionSnapshot',
      'externalId',
      'sourceVersion',
      'ownerCounterpartyId',
      'reservedForOrderId',
      'reservedForPositionId',
      'reservedByProposalId',
    ]) {
      expect(schema?.properties).not.toHaveProperty(forbidden);
    }
  });

  it('documents flexible payment policy endpoints and the nested invoice policy', () => {
    const document = createOpenApiDocument(app);
    const preview = document.paths['/api/finance/orders/{orderId}/payment-policy/preview']?.post;
    const replace = document.paths['/api/finance/orders/{orderId}/payment-policy']?.put;
    const invoiceSchema = document.components?.schemas?.CreateInvoiceDto as
      | { properties?: Record<string, unknown> }
      | undefined;
    const policySchema = document.components?.schemas?.PaymentPolicyDto as
      | { properties?: Record<string, unknown> }
      | undefined;
    const stageSchema = document.components?.schemas?.PaymentPolicyStageDto as
      | { required?: string[]; properties?: Record<string, unknown> }
      | undefined;

    expect(preview).toBeDefined();
    expect(replace).toBeDefined();
    expect(invoiceSchema?.properties?.paymentPolicy).toEqual(
      expect.objectContaining({ $ref: '#/components/schemas/PaymentPolicyDto' }),
    );
    expect(policySchema?.properties?.stages).toEqual(
      expect.objectContaining({
        type: 'array',
        items: { $ref: '#/components/schemas/PaymentPolicyStageDto' },
      }),
    );
    expect(stageSchema).toEqual(
      expect.objectContaining({
        required: expect.arrayContaining([
          'sequence',
          'trigger',
          'percentageBasisPoints',
          'offsetDays',
        ]),
        properties: expect.objectContaining({
          sequence: expect.objectContaining({ type: 'number', minimum: 1 }),
          trigger: expect.objectContaining({
            type: 'string',
            enum: ['invoice_issued', 'full_shipment'],
          }),
          percentageBasisPoints: expect.objectContaining({
            type: 'number',
            minimum: 1,
            maximum: 10_000,
          }),
          offsetDays: expect.objectContaining({
            type: 'number',
            minimum: 0,
            maximum: 3650,
          }),
        }),
      }),
    );
  });

  it('documents the secured 1С invoice and payment reconciliation workflow', () => {
    const document = createOpenApiDocument(app);
    const operations = [
      document.paths['/api/commercial/orders/{orderId}/finance-note']?.patch,
      document.paths['/api/finance/orders/{orderId}/source-retry']?.post,
      document.paths['/api/finance/orders/{orderId}/invoice-link']?.put,
      document.paths['/api/finance/payment-source-sync']?.post,
      document.paths['/api/finance/reconciliation']?.get,
      document.paths['/api/finance/payment-allocations/{allocationId}/resolve']?.post,
    ];

    for (const operation of operations) {
      expect(operation).toBeDefined();
      expect(operation?.security).toContainEqual({ session: [] });
    }

    expect(document.paths['/api/finance/payment-source-sync']?.post?.responses).toEqual(
      expect.objectContaining({
        '200': expect.any(Object),
        '400': expect.any(Object),
        '401': expect.any(Object),
        '403': expect.any(Object),
      }),
    );
  });

  it('documents payment preview dates as actual facts or undated conditions', () => {
    const document = createOpenApiDocument(app);
    const preview = document.paths['/api/finance/orders/{orderId}/payment-policy/preview']?.post;
    const response = preview?.responses?.['200'];
    const responseSchema =
      response && 'content' in response
        ? response.content?.['application/json']?.schema
        : undefined;
    const rowSchema = document.components?.schemas?.PaymentPolicyPreviewRowDto as
      | { properties?: Record<string, unknown> }
      | undefined;

    expect(responseSchema).toEqual({ $ref: '#/components/schemas/PaymentPolicyPreviewDto' });
    expect(rowSchema?.properties?.date).toEqual(
      expect.objectContaining({ type: 'string', nullable: true }),
    );
    expect(rowSchema?.properties?.dateKind).toEqual(
      expect.objectContaining({ enum: ['actual', 'condition'] }),
    );
  });

  it('documents the secured material and recipe catalogs with safe allowlisted schemas', () => {
    const document = createOpenApiDocument(app);
    const materialList = document.paths['/api/material-catalog']?.get;
    const recipeList = document.paths['/api/recipe-catalog']?.get;
    const recipeCreate = document.paths['/api/recipe-catalog']?.post;

    expect(materialList?.security).toContainEqual({ session: [] });
    expect(materialList?.responses).toEqual(
      expect.objectContaining({
        '200': expect.objectContaining({
          content: {
            'application/json': {
              schema: {
                type: 'array',
                items: { $ref: '#/components/schemas/RawMaterialCatalogItemResponseDto' },
              },
            },
          },
        }),
        '401': expect.any(Object),
        '403': expect.any(Object),
      }),
    );
    expect(recipeList?.security).toContainEqual({ session: [] });
    expect(recipeList?.responses).toEqual(
      expect.objectContaining({
        '200': expect.objectContaining({
          content: {
            'application/json': {
              schema: {
                type: 'array',
                items: { $ref: '#/components/schemas/RecipeCatalogItemResponseDto' },
              },
            },
          },
        }),
        '401': expect.any(Object),
        '403': expect.any(Object),
      }),
    );
    expect(recipeCreate?.security).toContainEqual({ session: [] });
    expect(recipeCreate?.responses).toEqual(
      expect.objectContaining({
        '201': expect.objectContaining({
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/RecipeCatalogItemResponseDto' },
            },
          },
        }),
        '400': expect.any(Object),
        '401': expect.any(Object),
        '403': expect.any(Object),
        '409': expect.any(Object),
      }),
    );

    const propertyKeys = (schemaName: string) =>
      Object.keys(
        (
          document.components?.schemas?.[schemaName] as
            | { properties?: Record<string, unknown> }
            | undefined
        )?.properties ?? {},
      ).sort();
    expect(propertyKeys('RawMaterialCatalogItemResponseDto')).toEqual(['id', 'kind', 'name']);
    expect(propertyKeys('RecipeCatalogItemResponseDto')).toEqual(['id', 'name', 'version']);
    expect(propertyKeys('RecipeCatalogVersionResponseDto')).toEqual([
      'id',
      'ingredients',
      'version',
    ]);
    expect(propertyKeys('RecipeIngredientShareResponseDto')).toEqual([
      'name',
      'rawMaterialDefinitionId',
      'shareBasisPoints',
    ]);
    expect(propertyKeys('CreatePositionDto')).toEqual(
      expect.arrayContaining([
        'baseRawMaterialDefinitionId',
        'recipeDefinitionVersionId',
        'recipeParameters',
      ]),
    );
    expect(propertyKeys('CreatePositionDto')).not.toContain('rawMaterialId');
    const createPositionSchema = document.components?.schemas?.CreatePositionDto as
      | { required?: string[] }
      | undefined;
    expect(createPositionSchema?.required).toEqual(
      expect.arrayContaining(['rollCount', 'filmType', 'actualThickness', 'accountingThickness']),
    );
    expect(createPositionSchema?.required).not.toContain('recipeParameters');
  });

  it('exposes only operator intent in shift and roll-assignment request schemas', () => {
    const document = createOpenApiDocument(app);
    const schemas = document.components?.schemas ?? {};
    const propertyKeys = (schemaName: string) =>
      Object.keys(
        (schemas[schemaName] as { properties?: Record<string, unknown> } | undefined)?.properties ??
          {},
      ).sort();
    const requiredKeys = (schemaName: string) =>
      [...((schemas[schemaName] as { required?: string[] } | undefined)?.required ?? [])].sort();
    const requestSchema = (path: string) => {
      const operation = document.paths[path]?.post;
      const requestBody =
        operation?.requestBody && 'content' in operation.requestBody
          ? operation.requestBody
          : undefined;
      return requestBody?.content?.['application/json']?.schema;
    };

    expect(requestSchema('/api/production/operator-shifts')).toEqual({
      $ref: '#/components/schemas/CreateIndividualShiftDto',
    });
    expect(requestSchema('/api/production/roll-dispatch/{rollId}/assign')).toEqual({
      $ref: '#/components/schemas/AssignRollDto',
    });
    expect(requestSchema('/api/production/roll-dispatch/bulk-assign')).toEqual({
      $ref: '#/components/schemas/BulkAssignDto',
    });
    expect(requestSchema('/api/production/roll-dispatch/batch-update')).toEqual({
      $ref: '#/components/schemas/BatchUpdateDispatchDto',
    });

    expect(propertyKeys('CreateIndividualShiftDto')).toEqual([
      'label',
      'operationKey',
      'operatorId',
      'postId',
    ]);
    expect(requiredKeys('CreateIndividualShiftDto')).toEqual([
      'operationKey',
      'operatorId',
      'postId',
    ]);
    expect(propertyKeys('AssignRollDto')).toEqual(['operatorId']);
    expect(requiredKeys('AssignRollDto')).toEqual(['operatorId']);
    expect(propertyKeys('BulkAssignDto')).toEqual(['operatorId', 'rollIds']);
    expect(requiredKeys('BulkAssignDto')).toEqual(['operatorId', 'rollIds']);
    expect(propertyKeys('DispatchDraftChangeDto')).toEqual(['operatorId', 'priority', 'rollId']);
    expect(requiredKeys('DispatchDraftChangeDto')).toEqual(['operatorId', 'rollId']);
    expect(propertyKeys('BatchUpdateDispatchDto')).toEqual(['changes']);
    expect(requiredKeys('BatchUpdateDispatchDto')).toEqual(['changes']);
  });

  it('documents the authoritative cost read and both audited cost commands', () => {
    const document = createOpenApiDocument(app);
    const rollRead =
      document.paths['/api/commercial/performance/production/{productionOrderId}/rolls']?.get;
    const spoolTypes = document.paths['/api/warehouse/spool-price-types']?.get;
    const spoolPrice = document.paths['/api/warehouse/spool-price-references']?.post;
    const correction =
      document.paths['/api/finance/production-costs/{rollDispatchItemId}/corrections']?.post;

    expect(rollRead?.responses?.['200']).toEqual(
      expect.objectContaining({
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/BusinessPerformanceRollPageResponseDto' },
          },
        },
      }),
    );
    expect(spoolTypes?.responses?.['200']).toEqual(
      expect.objectContaining({
        content: {
          'application/json': {
            schema: {
              type: 'array',
              items: { $ref: '#/components/schemas/SpoolPriceTypeResponseDto' },
            },
          },
        },
      }),
    );
    expect(spoolPrice?.responses?.['200']).toEqual(
      expect.objectContaining({
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/SpoolPriceReferenceResponseDto' },
          },
        },
      }),
    );
    expect(correction?.responses?.['201']).toEqual(
      expect.objectContaining({
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/RollProductionCostSnapshotResponseDto' },
          },
        },
      }),
    );

    const rollSchema = document.components?.schemas?.BusinessPerformanceRollItemResponseDto as
      | { required?: string[]; properties?: Record<string, unknown> }
      | undefined;
    expect(rollSchema?.required).toContain('productionCost');
    expect(rollSchema?.properties?.productionCost).toEqual({
      $ref: '#/components/schemas/RollProductionCostViewResponseDto',
    });
    expect(document.components?.schemas?.RollProductionCostViewResponseDto).toEqual(
      expect.objectContaining({
        required: expect.arrayContaining([
          'kind',
          'status',
          'calculationVersion',
          'basis',
          'additionalAmountKopecks',
          'unresolvedReasons',
        ]),
      }),
    );
    for (const operation of [rollRead, spoolTypes, spoolPrice, correction]) {
      expect(operation?.security).toContainEqual({ session: [] });
    }
  });
});
