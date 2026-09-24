import { Body, Controller, Get, HttpCode, Post, Res, StreamableFile } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiProduces,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { RequireCapabilities } from '../../common/auth/require-capabilities.decorator';
import { CurrentActor } from '../../common/auth/actor';
import type { Actor } from '../../common/auth/actor';
import {
  PalletLabelLayoutEditorBootstrapResponseDto,
  PreviewPalletLabelLayoutDto,
  PublishPalletLabelLayoutDto,
  PublishPalletLabelLayoutResponseDto,
} from './dto/pallet-label-layout-editor.dto';
import { PalletLabelLayoutEditorService } from './pallet-label-layout-editor.service';

const DIAGNOSTICS_HEADER = 'X-Pallet-Layout-Diagnostics';

@ApiTags('admin')
@ApiBearerAuth('session')
@Controller('admin/pallet-label-layout-editor')
export class PalletLabelLayoutEditorController {
  constructor(private readonly editor: PalletLabelLayoutEditorService) {}

  @Get()
  @RequireCapabilities('pallet_label_layout:manage')
  @ApiOkResponse({ type: PalletLabelLayoutEditorBootstrapResponseDto })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Pallet-label layout authority is required.' })
  async bootstrap(@Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.editor.bootstrap();
  }

  @Post('preview')
  @HttpCode(200)
  @RequireCapabilities('pallet_label_layout:manage')
  @ApiProduces('image/png')
  @ApiOkResponse({ description: 'Exact 800×800 PNG of the non-publishable watermarked draft.' })
  @ApiBadRequestResponse({ description: 'The submitted layout contract is malformed.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Pallet-label layout authority is required.' })
  @ApiNotFoundResponse({ description: 'The immutable source document was not found.' })
  @ApiUnprocessableEntityResponse({
    description: 'The source is unavailable or its content cannot fit the submitted layout.',
  })
  async preview(
    @Body() dto: PreviewPalletLabelLayoutDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const preview = await this.editor.preview(dto.sourceDocumentId, dto.layout);
    const diagnostics = Buffer.from(JSON.stringify(preview.diagnostics), 'utf8').toString(
      'base64url',
    );
    response.setHeader('Content-Type', 'image/png');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader(DIAGNOSTICS_HEADER, diagnostics);
    response.setHeader('Access-Control-Expose-Headers', DIAGNOSTICS_HEADER);
    return new StreamableFile(preview.png);
  }

  @Post('publish')
  @HttpCode(200)
  @RequireCapabilities('pallet_label_layout:manage')
  @ApiOkResponse({ type: PublishPalletLabelLayoutResponseDto })
  @ApiBadRequestResponse({ description: 'The publish command or layout is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Pallet-label layout authority is required.' })
  @ApiNotFoundResponse({ description: 'The immutable source document was not found.' })
  @ApiConflictResponse({ description: 'The operation key or active publication CAS conflicts.' })
  @ApiUnprocessableEntityResponse({ description: 'The source cannot render the layout.' })
  publish(@CurrentActor() actor: Actor, @Body() dto: PublishPalletLabelLayoutDto) {
    return this.editor.publish(actor, dto);
  }
}
