import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { PalletLabelLayoutEditorController } from './pallet-label-layout-editor.controller';
import { PalletLabelLayoutEditorService } from './pallet-label-layout-editor.service';

describe('pallet-label layout editor OpenAPI', () => {
  it('documents V2 editor requests and the V1/V2 immutable publication union', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PalletLabelLayoutEditorController],
      providers: [
        {
          provide: PalletLabelLayoutEditorService,
          useValue: { bootstrap: jest.fn(), preview: jest.fn(), publish: jest.fn() },
        },
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    try {
      const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
      const schemas = document.components?.schemas as Record<
        string,
        { properties?: Record<string, Record<string, unknown>> }
      >;
      const editableLayout = schemas.PalletLabelLayoutResponseDto;
      const editableElement = schemas.PalletLabelLayoutElementResponseDto;
      const bootstrap = schemas.PalletLabelLayoutEditorBootstrapResponseDto;
      const publication = schemas.PalletLabelLayoutPublicationResponseDto;

      expect(editableLayout.properties?.schemaVersion).toMatchObject({ enum: [2] });
      expect(editableElement.properties?.id).toMatchObject({
        enum: ['order', 'customer', 'formedAt', 'rollCount', 'qr', 'storage'],
      });
      expect(editableElement.properties?.kind).toMatchObject({ enum: ['text', 'qr'] });
      expect(bootstrap.properties).toHaveProperty('editorLayout');
      expect(bootstrap.properties).not.toHaveProperty('publishedLayout');
      expect(publication.properties?.layout).toMatchObject({
        oneOf: [
          { $ref: '#/components/schemas/LegacyPalletLabelLayoutResponseDto' },
          { $ref: '#/components/schemas/PalletLabelLayoutResponseDto' },
        ],
      });
    } finally {
      await app.close();
    }
  });
});
