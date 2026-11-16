import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Errors } from '../../common/errors/domain-error';
import { formatMinor } from '../../common/money/money';
import { decodeCursor, encodeCursor } from '../../common/util/cursor';
import { isValidUserId } from '../../common/validation/user-id';
import { LedgerService } from '../ledger/ledger.service';
import { LedgerPageDto, LedgerQueryDto, WalletResponseDto } from './wallets.dto';

@ApiTags('Wallets')
@Controller('wallets')
export class WalletsController {
  constructor(private readonly ledger: LedgerService) {}

  @Get(':userId')
  @ApiOperation({ summary: 'Balances of a user (zero balances for a user who never transacted)' })
  @ApiOkResponse({ type: WalletResponseDto })
  async getWallet(@Param('userId') userId: string): Promise<WalletResponseDto> {
    if (!isValidUserId(userId)) throw Errors.validation('userId is invalid');
    const balances = await this.ledger.getUserBalances(userId);
    return {
      userId,
      balances: balances.map((b) => ({
        currency: b.currency,
        available: formatMinor(b.currency, b.available),
        held: formatMinor(b.currency, b.held),
        total: formatMinor(b.currency, b.available + b.held),
        debt: formatMinor(b.currency, b.receivable),
      })),
    };
  }

  @Get(':userId/ledger')
  @ApiOperation({
    summary: 'Ledger history of a user, newest first',
    description: 'Keyset pagination: pass `nextCursor` back as `cursor`. Stays fast for millions of entries.',
  })
  @ApiOkResponse({ type: LedgerPageDto })
  async getLedger(@Param('userId') userId: string, @Query() query: LedgerQueryDto): Promise<LedgerPageDto> {
    if (!isValidUserId(userId)) throw Errors.validation('userId is invalid');
    let beforeId: string | null = null;
    if (query.cursor) {
      beforeId = decodeCursor(query.cursor);
      if (!beforeId) throw Errors.validation('cursor is invalid');
    }
    const limit = query.limit ?? 50;
    const page = await this.ledger.getUserLedgerPage(userId, { limit, beforeId, currency: query.currency });
    const last = page.items[page.items.length - 1];
    return { items: page.items, nextCursor: page.hasMore && last ? encodeCursor(last.id) : null };
  }
}
